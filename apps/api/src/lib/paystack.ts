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

// ============================================================================
// Plans, customers and subscriptions
//
// Recurring billing runs on Paystack's own engine rather than a local imitation of
// it: a KaziOS price becomes a Paystack plan, a verified first payment creates a
// customer and a subscription against that plan, and renewals arrive as signed
// webhook events that the server still confirms with Paystack before applying.
// Every call here is server-side; the secret key never leaves this process.
// ============================================================================

async function callGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
  return json.data as T;
}

/** The intervals Paystack will build a recurring plan for. */
const PAYSTACK_PLAN_INTERVALS = new Set(["daily", "weekly", "monthly", "yearly"]);

export interface PaystackPlan {
  plan_code: string;
  name: string;
  interval: string;
  amount: number;
  currency: string;
}

export interface PaystackCustomer {
  id?: number;
  customer_code: string;
  email: string;
}

export interface PaystackSubscription {
  subscription_code: string;
  status: string;
  email_token?: string;
  customer: { customer_code?: string; email?: string };
  plan: { plan_code?: string; name?: string };
  next_payment_date?: string | null;
}

/**
 * Creates the Paystack plan behind one of our price rows.
 *
 * Amounts are in the currency's subunit exactly as our rows hold them, so the plan the
 * provider charges is defined by the same number the pricing page displays. A interval
 * Paystack does not model (our "custom") has no plan here by design: Enterprise is
 * quoted, not subscribed to.
 */
export async function createPlan(input: {
  name: string;
  interval: string;
  amountInCents: number;
  currency: string;
}): Promise<PaystackPlan> {
  if (!isPaystackEnabled()) {
    throw new PaystackError("Card payments are not configured on this server", 503);
  }
  if (!PAYSTACK_PLAN_INTERVALS.has(input.interval)) {
    throw new PaystackError(`Paystack does not offer a ${input.interval} plan interval`, 400);
  }
  return call<PaystackPlan>("/plan", {
    name: input.name,
    interval: input.interval,
    amount: input.amountInCents,
    currency: input.currency.toUpperCase(),
  });
}

/** Reads a plan back. Returns null when the provider has never heard of it. */
export async function fetchPlan(planCode: string): Promise<PaystackPlan | null> {
  if (!isPaystackEnabled()) return null;
  try {
    return await callGet<PaystackPlan>(`/plan/${encodeURIComponent(planCode)}`);
  } catch (err) {
    if (err instanceof PaystackError && err.status === 404) return null;
    throw err;
  }
}

/** Finds a customer by email, or null. Used so retries reuse one customer per business. */
export async function findCustomerByEmail(email: string): Promise<PaystackCustomer | null> {
  if (!isPaystackEnabled()) return null;
  try {
    return await callGet<PaystackCustomer>(`/customer/${encodeURIComponent(email)}`);
  } catch (err) {
    if (err instanceof PaystackError && err.status === 404) return null;
    throw err;
  }
}

export async function createCustomer(input: {
  email: string;
  firstName?: string;
}): Promise<PaystackCustomer> {
  if (!isPaystackEnabled()) {
    throw new PaystackError("Card payments are not configured on this server", 503);
  }
  return call<PaystackCustomer>("/customer", {
    email: input.email,
    ...(input.firstName ? { first_name: input.firstName } : {}),
  });
}

/**
 * Subscribes a customer to a plan, which is what makes the provider charge them again
 * when the period ends. The card token behind that charge was collected by the checkout
 * the customer just completed; nothing here ever sees a card number.
 */
export async function createSubscription(input: {
  customerCode: string;
  planCode: string;
}): Promise<PaystackSubscription> {
  if (!isPaystackEnabled()) {
    throw new PaystackError("Card payments are not configured on this server", 503);
  }
  return call<PaystackSubscription>("/subscription", {
    customer: input.customerCode,
    plan: input.planCode,
  });
}

export async function fetchSubscription(subscriptionCode: string): Promise<PaystackSubscription | null> {
  if (!isPaystackEnabled()) return null;
  try {
    return await callGet<PaystackSubscription>(`/subscription/${encodeURIComponent(subscriptionCode)}`);
  } catch (err) {
    if (err instanceof PaystackError && err.status === 404) return null;
    throw err;
  }
}

/** Stops future renewals. The customer keeps the period they already paid for. */
export async function disableSubscription(subscriptionCode: string): Promise<void> {
  if (!isPaystackEnabled()) return;
  await call(`/subscription/enable/${encodeURIComponent(subscriptionCode)}/disable`, {});
}

/** Turns renewals back on after a cancellation was withdrawn. */
export async function enableSubscription(subscriptionCode: string): Promise<void> {
  if (!isPaystackEnabled()) return;
  await call(`/subscription/enable/${encodeURIComponent(subscriptionCode)}/enable`, {});
}
