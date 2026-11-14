import axios from "axios";
import type { AxiosInstance } from "axios";
import { loadConfig } from "@kazios/config";
import { AppError } from "../../middleware/errorHandler";
import type { EtimsEnvelope } from "./envelope";

/**
 * The seam between KaziOS and KRA.
 *
 * There is deliberately no hardcoded KRA URL or endpoint path in this file. The eTIMS
 * sandbox and production hosts differ, and a control unit's submit path is issued with
 * the credentials — guessing either would point a live business at the wrong place and
 * lose real invoices. Everything the adapter needs comes from the environment, and when
 * any of it is missing the client reports itself unconfigured rather than half-working.
 *
 * What is implemented here is the transport: an OAuth2 client-credentials token, cached
 * until it expires, and a POST carrying the envelope. The body KRA expects is mapped in
 * `toKraBody`, which is the one place to change when the control unit's schema is known.
 */

export interface EtimsSubmitResult {
  kraInvoiceNumber?: string;
  qrCode?: string;
  /** The raw KRA response, kept so nothing is lost when its shape surprises us. */
  raw?: unknown;
}

export interface EtimsClient {
  /** False when credentials are absent. Callers queue instead of failing the sale. */
  readonly configured: boolean;
  /** Human-readable reason, for the settings screen. */
  readonly reason: string | null;
  submit(envelope: EtimsEnvelope): Promise<EtimsSubmitResult>;
}

const NO_CREDENTIALS =
  "KRA eTIMS is not configured. Add the KRA PIN, client id, client secret, token URL and submit path to file invoices with KRA.";

/**
 * The client used until credentials exist.
 *
 * It fails loudly rather than quietly: a business that believes its invoices are being
 * filed when they are not has a compliance problem it will not discover until an audit.
 */
class UnconfiguredEtimsClient implements EtimsClient {
  readonly configured = false;
  readonly reason = NO_CREDENTIALS;

  async submit(): Promise<EtimsSubmitResult> {
    throw new AppError(
      503,
      "KRA eTIMS is not configured on this server, so this invoice cannot be filed automatically. Record the KRA invoice number by hand instead.",
      "ETIMS_NOT_CONFIGURED"
    );
  }
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

class HttpEtimsClient implements EtimsClient {
  readonly configured = true;
  readonly reason = null;

  private http: AxiosInstance;
  private token: TokenCache | null = null;

  constructor(
    private readonly settings: {
      apiUrl: string;
      clientId: string;
      clientSecret: string;
      tokenUrl: string;
      submitPath: string;
      tin: string;
      certificate: string | null;
    }
  ) {
    this.http = axios.create({
      baseURL: settings.apiUrl.replace(/\/$/, ""),
      timeout: 20_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Client-credentials token, reused until a minute before it lapses. */
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }

    const res = await axios.post(
      this.settings.tokenUrl,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20_000 }
    );

    const body = res.data as { access_token?: string; expires_in?: number };
    if (!body?.access_token) {
      throw new AppError(502, "KRA did not issue an access token. Check the eTIMS credentials.");
    }

    const ttlSeconds = Number(body.expires_in ?? 3600);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (Number.isFinite(ttlSeconds) ? ttlSeconds : 3600) * 1000,
    };
    return this.token.value;
  }

  async submit(envelope: EtimsEnvelope): Promise<EtimsSubmitResult> {
    let token = await this.getToken();

    const send = () =>
      this.http.post(this.settings.submitPath, this.toKraBody(envelope), {
        headers: {
          Authorization: `Bearer ${token}`,
          tin: this.settings.tin,
          ...(this.settings.certificate ? { certificate: this.settings.certificate } : {}),
        },
      });

    try {
      const res = await send();
      return this.parse(res.data, envelope);
    } catch (err) {
      // A token can lapse between the cache check and the call. One refresh, then the
      // error is real and the caller queues the invoice for the next sweep.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status !== 401) throw err;

      token = await this.getToken(true);
      const res = await send();
      return this.parse(res.data, envelope);
    }
  }

  /**
   * Maps our envelope onto KRA's body.
   *
   * The field names below are the documented eTIMS invoice elements. If a control unit
   * expects something else, this is the only function to change — the till, the outbox
   * and the reports all read the normalized envelope above.
   */
  private toKraBody(envelope: EtimsEnvelope): Record<string, unknown> {
    return {
      // KRA identifies the sending device by TIN; ours is the business's.
      organisation: {
        name: envelope.organisation.name,
        pin: envelope.organisation.pin,
        address: envelope.organisation.address,
        phone: envelope.organisation.phone,
        email: envelope.organisation.email,
      },
      invoice: {
        number: envelope.invoice.number,
        issueDate: envelope.invoice.issueDate,
        currency: envelope.invoice.currency,
        subtotal: envelope.invoice.subtotal,
        discountTotal: envelope.invoice.discountTotal,
        taxTotal: envelope.invoice.taxTotal,
        total: envelope.invoice.total,
      },
      customer: envelope.customer,
      lines: envelope.lines.map(line => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        taxRate: line.taxRate,
        taxable: line.taxable,
        taxAmount: line.taxAmount,
        lineTotal: line.lineTotal,
      })),
      taxBands: envelope.taxBands,
      payments: envelope.payments,
    };
  }

  /**
   * Reads KRA's answer defensively.
   *
   * The response envelope differs between the sandbox and production and has changed
   * between releases, so the number is looked for in the places it has appeared rather
   * than assumed to be in one. The whole body is kept either way: an unexpected shape
   * should be visible in the row, not swallowed.
   */
  private parse(body: unknown, envelope: EtimsEnvelope): EtimsSubmitResult {
    const record = (body ?? {}) as Record<string, unknown>;
    const result = (record.result ?? record.data ?? record) as Record<string, unknown>;

    const kraInvoiceNumber =
      (result.invoiceNumber as string | undefined) ??
      (result.kraInvoiceNumber as string | undefined) ??
      (record.invoiceNumber as string | undefined) ??
      envelope.invoice.number;

    const qrCode =
      (result.qrCode as string | undefined) ??
      (result.qrCodeData as string | undefined) ??
      (record.qrCode as string | undefined) ??
      null;

    return {
      kraInvoiceNumber: typeof kraInvoiceNumber === "string" ? kraInvoiceNumber : undefined,
      qrCode: typeof qrCode === "string" && qrCode ? qrCode : undefined,
      raw: body,
    };
  }
}

/**
 * The client for this process, built from the environment.
 *
 * Constructed per call rather than cached at module load so a redeploy that adds
 * credentials takes effect without a restart, and so tests can point at a stub host.
 */
export function getEtimsClient(): EtimsClient {
  const config = loadConfig().etims;
  const ready = Boolean(
    config.enabled &&
    config.apiUrl &&
    config.clientId &&
    config.clientSecret &&
    config.tokenUrl &&
    config.submitPath &&
    config.tin
  );

  if (!ready) return new UnconfiguredEtimsClient();

  return new HttpEtimsClient({
    apiUrl: config.apiUrl!,
    clientId: config.clientId!,
    clientSecret: config.clientSecret!,
    tokenUrl: config.tokenUrl!,
    submitPath: config.submitPath!,
    tin: config.tin!,
    certificate: config.certificate ?? null,
  });
}
