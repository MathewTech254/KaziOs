import { createHmac, timingSafeEqual } from "crypto";
import { loadConfig } from "@kazios/config";

const BASE = "https://api.paystack.co";

/**
 * The key is read through the validated config rather than straight from the
 * environment, so a quoted value or a missing key behaves the same everywhere.
 */
function secretKey(): string {
  try {
    return loadConfig().paystack.secretKey || "";
  } catch {
    return "";
  }
}

/** Card payments are offered only when a usable secret key is actually configured. */
export function isPaystackEnabled(): boolean {
  return Boolean(secretKey());
}

export class PaystackError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secretKey()}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new PaystackError("The payment provider returned an unreadable response", 502);
  }

  if (!res.ok || json.status === false) {
    throw new PaystackError(json.message || `Payment provider error (${res.status})`, res.status);
  }
  return json.data as T;
}

export interface InitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface VerifiedTransaction {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  email: string;
  paid_at?: string | null;
  transaction_id: number;
}

/** Starts a transaction. The amount is in the currency's subunit, so KES 100 is 10000. */
export async function initializeTransaction(input: {
  email: string;
  amountInCents: number;
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}): Promise<InitializeResult> {
  if (!isPaystackEnabled()) {
    throw new PaystackError("Card payments are not configured on this server", 503);
  }

  return call<InitializeResult>("/transaction/initialize", {
    email: input.email,
    amount: input.amountInCents,
    currency: input.currency,
    reference: input.reference,
    ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

/** Asks Paystack directly whether the money actually arrived. */
export async function verifyTransaction(reference: string): Promise<VerifiedTransaction> {
  if (!isPaystackEnabled()) {
    throw new PaystackError("Card payments are not configured on this server", 503);
  }
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new PaystackError("The payment provider returned an unreadable response", 502);
  }
  if (!res.ok || json.status === false) {
    throw new PaystackError(json.message || `Payment provider error (${res.status})`, res.status);
  }
  return json.data as VerifiedTransaction;
}

/**
 * Confirms a webhook really came from Paystack. The signature is an HMAC-SHA512 of the
 * raw request body keyed with the secret key, so anyone who can post a fake
 * "payment succeeded" is refused. A missing secret means no event can be trusted, and
 * an unverified event must never mark an invoice paid.
 */
export function isValidWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  const secret = secretKey();
  // Without a secret key no event can be trusted, and an unverified event must never
  // mark an invoice paid, so this refuses rather than guessing.
  if (!secret || !signature) return false;

  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const received = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

/** Paystack will not charge below these, and a smaller charge is refused outright. */
const MINIMUM_CENTS: Record<string, number> = {
  KES: 300,
  NGN: 5000,
  GHS: 10,
  ZAR: 100,
  USD: 200,
  XOF: 100,
};

export function minimumChargeCents(currency: string): number {
  return MINIMUM_CENTS[currency.toUpperCase()] ?? 100;
}
