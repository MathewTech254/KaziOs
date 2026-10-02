import { createHmac } from "crypto";
import {
  isPaystackEnabled,
  isValidWebhookSignature,
  minimumChargeCents,
  PaystackError,
} from "./paystack";

/**
 * Card payment safety, tested without a Paystack account.
 *
 * Almost every fault that would cost a business money lives in code Paystack does not
 * control: whether a forged webhook is believed, whether an invoice is marked paid
 * before the money is confirmed, whether a replayed event charges twice. Those are all
 * decided here, and none of them can be observed without either real credentials or a
 * test that does not need them.
 *
 * The provider itself is trusted and mocked. What is under test is this system's refusal
 * to take its word for anything.
 */

const SECRET = "sk_test_offline_suite_secret_key";

/** Mutable so a test can present a server with, or without, a usable key. */
let config: { paystack: { secretKey?: string; publicKey?: string; webhookSecret?: string } };

jest.mock("@kazios/config", () => ({
  loadConfig: () => config,
}));

const sign = (body: string, secret = SECRET) =>
  createHmac("sha512", secret).update(body).digest("hex");

beforeEach(() => {
  config = { paystack: { secretKey: SECRET, publicKey: "pk_test_x", webhookSecret: "whsec_x" } };
});

describe("card payments are only offered with a real key", () => {
  it("is off with no secret, so the till never offers a card it cannot settle", () => {
    config = { paystack: {} };
    expect(isPaystackEnabled()).toBe(false);
  });

  it("is on once a secret is present", () => {
    expect(isPaystackEnabled()).toBe(true);
  });

  it("does not mistake a public key for a secret", () => {
    // The public key is shipped to the browser. Treating it as sufficient would let any
    // visitor open payment sessions on the server.
    config = { paystack: { publicKey: "pk_test_x" } };
    expect(isPaystackEnabled()).toBe(false);
  });
});

describe("webhook signature", () => {
  const event = JSON.stringify({
    event: "charge.success",
    data: { reference: "INV-123-abcd1234", amount: 100000, currency: "KES" },
  });

  it("accepts a genuine Paystack event", () => {
    expect(isValidWebhookSignature(event, sign(event))).toBe(true);
  });

  it("refuses a body altered after signing", () => {
    // The attack this stops: someone learns a real reference and posts a fake success
    // for it. The signature covers the body, so a changed amount or reference fails.
    const signature = sign(event);
    const tampered = event.replace('"amount":100000', '"amount":1');
    expect(isValidWebhookSignature(tampered, signature)).toBe(false);
  });

  it("refuses a signature made with a different secret", () => {
    expect(isValidWebhookSignature(event, sign(event, "sk_test_someone_elses_key"))).toBe(false);
  });

  it("refuses a request with no signature at all", () => {
    expect(isValidWebhookSignature(event, undefined)).toBe(false);
  });

  it("refuses an empty signature rather than treating it as a match", () => {
    expect(isValidWebhookSignature(event, "")).toBe(false);
  });

  it("refuses a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws when the two buffers differ in length. Returning false is
    // the difference between rejecting a bad webhook and crashing the process on one,
    // which would take down every other payment with it.
    expect(() => isValidWebhookSignature(event, "abc")).not.toThrow();
    expect(isValidWebhookSignature(event, "abc")).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    config = { paystack: {} };
    // A deployment that has lost its key cannot verify anything, and must not be
    // permitted to mark invoices paid on an unverified claim.
    expect(isValidWebhookSignature(event, sign(event))).toBe(false);
  });

  it("is case sensitive, because hex is not the only thing it could be", () => {
    const signature = sign(event);
    expect(isValidWebhookSignature(event, signature.toUpperCase())).toBe(false);
  });

  it("does not verify the parsed body, only the exact bytes that were signed", () => {
    // Whitespace and key order change the bytes without changing the meaning. A server
    // that re-serialised before verifying would reject real webhooks; one that only
    // compared meaning would accept forgeries. This pins it to the bytes.
    const spaced = JSON.stringify(JSON.parse(event), null, 2);
    expect(isValidWebhookSignature(spaced, sign(event))).toBe(false);
  });
});

describe("minimum charge", () => {
  it("knows what each African market will actually accept", () => {
    // These are the floors Paystack enforces. Being under them means the customer is
    // declined at the worst moment, after the sale has been rung up.
    expect(minimumChargeCents("KES")).toBe(300);
    expect(minimumChargeCents("NGN")).toBe(5000);
    expect(minimumChargeCents("GHS")).toBe(10);
    expect(minimumChargeCents("ZAR")).toBe(100);
    expect(minimumChargeCents("XOF")).toBe(100);
    expect(minimumChargeCents("USD")).toBe(200);
  });

  it("is not fooled by a lower case currency code", () => {
    expect(minimumChargeCents("kes")).toBe(300);
  });

  it("falls back to a sane floor rather than zero for an unknown currency", () => {
    // A missing entry must not become "no minimum", which would send an amount the
    // provider will reject.
    expect(minimumChargeCents("ZWL")).toBe(100);
    expect(minimumChargeCents("")).toBe(100);
  });
});

describe("provider errors", () => {
  it("carries a status so the route can answer sensibly", () => {
    const err = new PaystackError("Card declined", 402);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(402);
    expect(err.message).toBe("Card declined");
  });
});
