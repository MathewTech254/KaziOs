import { loadConfig } from "@kazios/config";

/**
 * Safaricom Daraja (M-PESA Express / STK Push) — the second payment rail.
 *
 * This mirrors `lib/paystack` deliberately rather than generalising it: the two
 * providers share nothing but their invariants, and forcing them through one
 * abstraction is how a change for one silently breaks the other. The rule from
 * `docs/SUBSCRIPTIONS.md` is restated here in M-PESA's terms:
 *
 *   `stkPush` only opens. `stkQuery` asks Safaricom what really happened, with
 *   our own credentials, keyed on the CheckoutRequestID Safaricom handed us.
 *   Daraja callbacks are not signed (there is no HMAC equivalent), so the
 *   query *is* the verification — a callback can only ever trigger one, never
 *   substitute for one.
 */

const SANDBOX_BASE = "https://sandbox.safaricom.co.ke";
const PRODUCTION_BASE = "https://api.safaricom.co.ke";

function cfg() {
  try {
    return loadConfig().mpesa;
  } catch {
    return {
      consumerKey: undefined,
      consumerSecret: undefined,
      shortcode: undefined,
      passkey: undefined,
      environment: "sandbox",
      callbackUrl: undefined,
    };
  }
}

function baseUrl(): string {
  return cfg().environment === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

/** M-PESA is offered only when all four credentials are actually configured. */
export function isMpesaEnabled(): boolean {
  const c = cfg();
  return Boolean(c.consumerKey && c.consumerSecret && c.shortcode && c.passkey);
}

export class MpesaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "MpesaError";
  }
}

// ============================================================================
// Token
// ============================================================================

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * OAuth token, cached until just before it expires.
 *
 * Daraja tokens live about an hour. Fetching one per request wastes a round
 * trip on every call; caching forever breaks the moment it lapses. The minute
 * of margin means a token is refreshed before the expiry, not after a 401.
 */
async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const c = cfg();
  if (!c.consumerKey || !c.consumerSecret) {
    throw new MpesaError("M-PESA is not configured on this server", 503);
  }

  const basic = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString("base64");
  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  }).catch(() => {
    throw new MpesaError("M-PESA could not be reached", 502);
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new MpesaError("M-PESA returned an unreadable response", 502);
  }
  if (!res.ok || !json.access_token) {
    throw new MpesaError(
      json.error_description || json.errorMessage || "M-PESA authentication failed",
      res.status === 401 ? 503 : 502
    );
  }

  const ttlSeconds = Number(json.expires_in) || 3599;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
  return cachedToken.value;
}

/** Called after a 401 mid-flight so the next attempt fetches a fresh token. */
function invalidateToken(): void {
  cachedToken = null;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let token = await accessToken();
  const attempt = () =>
    fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }).catch(() => {
      throw new MpesaError("M-PESA could not be reached", 502);
    });

  let res = await attempt();

  // A token can lapse between the cache check and the call. One retry with a
  // freshly minted token covers it; a second failure is a real failure.
  if (res.status === 401) {
    invalidateToken();
    token = await accessToken();
    res = await attempt();
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new MpesaError("M-PESA returned an unreadable response", 502);
  }

  if (!res.ok) {
    throw new MpesaError(
      json.errorMessage || json.error_description || `M-PESA error (${res.status})`,
      // 429 is the provider being busy — bursts arrive from the poll and the
      // callback together — and grouping it with the 5xx codes keeps it out
      // of the "rejected" bucket, which is reserved for Daraja's own answer
      // to a well-formed request.
      res.status >= 500 || res.status === 429 ? 502 : 400
    );
  }
  return json as T;
}

// ============================================================================
// Request material
// ============================================================================

/**
 * `YYYYMMDDHHMMSS` in East Africa Time, which is what the Password is derived
 * from. Generated from the clock in UTC+3 regardless of the server's own
 * timezone, because Safaricom compares it against Nairobi's.
 */
function eatTimestamp(): string {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    eat.getUTCFullYear() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/** `Base64(Shortcode + Passkey + Timestamp)`, per the Daraja spec. */
function stkPassword(timestamp: string): string {
  const c = cfg();
  if (!c.shortcode || !c.passkey) {
    throw new MpesaError("M-PESA is not configured on this server", 503);
  }
  return Buffer.from(`${c.shortcode}${c.passkey}${timestamp}`).toString("base64");
}

/**
 * Normalises any Kenyan number a human might type to `254XXXXXXXXX`, the only
 * format Daraja accepts: no plus, no leading zero.
 *
 * Returns null rather than throwing, so the caller decides whether a bad
 * number is a validation error or a silent skip.
 */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  const candidates = [
    digits, // 254712345678
    digits.replace(/^0/, "254"), // 0712345678
    `254${digits}`, // 712345678
  ];
  for (const candidate of candidates) {
    if (/^254(7|1)\d{8}$/.test(candidate)) return candidate;
  }
  return null;
}

// ============================================================================
// STK Push
// ============================================================================

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage: string;
}

/**
 * Sends the payment prompt to the customer's phone.
 *
 * The amount arrives in whole shillings — M-PESA has no subunit and Daraja
 * rejects decimals — which the caller works out from the plan's price row,
 * never from anything the browser said. The CheckoutRequestID returned here is
 * the join between this attempt and everything Safaricom says about it later;
 * the caller stores it before anything else can happen.
 */
export async function stkPush(input: {
  phone: string;
  amountShillings: number;
  reference: string;
  callbackUrl: string;
}): Promise<StkPushResult> {
  const c = cfg();
  if (!isMpesaEnabled()) {
    throw new MpesaError("M-PESA payments are not configured on this server", 503);
  }
  if (!Number.isInteger(input.amountShillings) || input.amountShillings < 1) {
    // A fractional or non-positive amount is a bug in the price row, not
    // something to round: charging a different number than the plan states is
    // the substitution this system must never permit.
    throw new MpesaError(
      "M-PESA can only charge whole shillings; this plan's price cannot be paid this way",
      400
    );
  }

  const phone = normalizeMsisdn(input.phone);
  if (!phone) {
    throw new MpesaError("Enter a valid Kenyan phone number (e.g. 0712345678)", 400);
  }

  const timestamp = eatTimestamp();
  const json = await call<{
    MerchantRequestID?: string;
    CheckoutRequestID?: string;
    ResponseCode?: string;
    CustomerMessage?: string;
    errorMessage?: string;
  }>("/mpesa/stkpush/v1/processrequest", {
    BusinessShortCode: c.shortcode,
    Password: stkPassword(timestamp),
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: input.amountShillings,
    PartyA: phone,
    PartyB: c.shortcode,
    PhoneNumber: phone,
    CallBackURL: input.callbackUrl,
    // Displayed on the customer's prompt. Daraja caps it at 12 characters;
    // the CheckoutRequestID, not this, is what the settlement joins on.
    AccountReference: input.reference.slice(0, 12),
    TransactionDesc: "KaziOS plan".slice(0, 13),
  });

  if (json.ResponseCode !== "0" || !json.CheckoutRequestID) {
    throw new MpesaError(
      json.errorMessage || json.CustomerMessage || "M-PESA did not accept the request",
      502
    );
  }

  return {
    checkoutRequestId: json.CheckoutRequestID,
    merchantRequestId: json.MerchantRequestID || "",
    customerMessage: json.CustomerMessage || "Check your phone for the M-PESA prompt",
  };
}

// ============================================================================
// STK Query — the verification half
// ============================================================================

export type StkQueryResult =
  | {
      state: "SUCCESS";
      receipt: string | null;
      /** From the provider's own metadata, in shillings, when it reports one. */
      amountShillings: number | null;
      paidAt: string | null;
    }
  | {
      state: "FAILED";
      resultCode: number;
      resultDesc: string;
    }
  | {
      /** The provider has not decided yet: the customer is still at the prompt. */
      state: "PENDING";
    };

/**
 * Asks Safaricom what actually happened to one STK push.
 *
 * This is the M-PESA counterpart of `verifyTransaction`, and it carries the
 * same weight: a callback or a returning browser may *trigger* this question,
 * but only this answer decides whether money moved. Keyed on the
 * CheckoutRequestID we stored at push time, so it can only ever speak about
 * the one attempt it belongs to.
 */
export async function stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
  const c = cfg();
  if (!isMpesaEnabled()) {
    throw new MpesaError("M-PESA payments are not configured on this server", 503);
  }

  const timestamp = eatTimestamp();
  let json: any;
  try {
    json = await call<any>("/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: c.shortcode,
      Password: stkPassword(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
  } catch (err) {
    // Daraja answers "still processing" and several malformed-request shapes
    // as HTTP errors rather than as a result. Those mean "no verdict yet",
    // which is PENDING — not a failure, and certainly not a success. Anything
    // else (auth, transport) keeps its original meaning: the caller leaves the
    // row untouched, exactly as the Paystack path does when it cannot reach
    // the provider.
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      err instanceof MpesaError &&
      err.status !== 503 &&
      (message.includes("processing") ||
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("not been processed") ||
        message.includes("cannot be processed"))
    ) {
      return { state: "PENDING" };
    }
    throw err;
  }

  const stk = json?.Body?.stkCallback;
  if (!stk || stk.ResultCode === undefined || stk.ResultCode === null) {
    // A 200 without a verdict: treat the same as "not decided yet".
    return { state: "PENDING" };
  }

  const resultCode = Number(stk.ResultCode);
  if (resultCode !== 0) {
    return {
      state: "FAILED",
      resultCode,
      resultDesc: String(stk.ResultDesc || `M-PESA reported ${resultCode}`),
    };
  }

  const items: any[] = stk.CallbackMetadata?.Item ?? [];
  const read = (name: string): any => items.find(item => item?.Name === name)?.Value;
  const amount = read("Amount");
  const date = read("TransactionDate");

  return {
    state: "SUCCESS",
    receipt: read("MpesaReceiptNumber") != null ? String(read("MpesaReceiptNumber")) : null,
    amountShillings: amount != null ? Number(amount) : null,
    paidAt: date != null ? String(date) : null,
  };
}

/**
 * The customer-facing sentence for a Daraja result code.
 *
 * The raw codes ("1037", "DS timeout user cannot be reached") mean nothing to
 * a shop owner watching their phone, so every failure the checkout shows goes
 * through here first.
 */
export function describeStkFailure(resultCode: number, resultDesc?: string): string {
  switch (resultCode) {
    case 1032:
      return "The M-PESA prompt was cancelled on your phone. Nothing has been charged.";
    case 1037:
      return "The M-PESA prompt expired before it was answered. Nothing has been charged.";
    case 1:
      return "The M-PESA payment could not be completed: insufficient balance.";
    case 2001:
      return "The wrong M-PESA PIN was entered. Nothing has been charged.";
    case 1019:
      return "The M-PESA transaction expired before it completed. Nothing has been charged.";
    default:
      return `The M-PESA payment did not complete (${resultDesc || resultCode}). Nothing has been charged.`;
  }
}
