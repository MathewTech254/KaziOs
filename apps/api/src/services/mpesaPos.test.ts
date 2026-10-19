import { prisma } from "../lib/prisma";
import {
  confirmMpesaPosPayment,
  resetMpesaPosQueryThrottle,
  startMpesaPosPayment,
} from "./mpesaPos";
import { settleCardPayment } from "../lib/cardPayments";
import { isMpesaEnabled, MpesaError, stkPush, stkQuery } from "../lib/mpesa";

/**
 * The M-PESA half of POS sales, tested without a Safaricom account.
 *
 * The same questions as `mpesaBilling.test.ts`, asked at the till: what does
 * this system charge, what does it refuse, and what does it take as proof that
 * money moved? A browser-supplied amount, a half-shilling balance, a card
 * reference on this route, a prompt the customer cancelled — none of those need
 * live Daraja credentials to prove, which is the point: the credentials arrive
 * later, the invariants are tested now.
 *
 * `lib/mpesa` is partially mocked — `normalizeMsisdn` and `describeStkFailure`
 * stay real, because they are pure logic and their behaviour is part of what is
 * being asserted. The network halves (`stkPush`, `stkQuery`) are the doubles.
 * `settleCardPayment` is doubled too: these tests prove the service *reaches*
 * the one settle path correctly; `cardPayments.test.ts` owns what happens once
 * it is there.
 */

jest.mock("../lib/prisma", () => ({
  prisma: {
    invoice: { findFirst: jest.fn(), findUnique: jest.fn() },
    cardPayment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../lib/cardPayments", () => ({
  settleCardPayment: jest.fn(),
}));

jest.mock("../lib/mpesa", () => {
  const actual = jest.requireActual("../lib/mpesa");
  return {
    ...actual,
    isMpesaEnabled: jest.fn(() => true),
    stkPush: jest.fn(),
    stkQuery: jest.fn(),
  };
});

const gateway = {
  isMpesaEnabled: isMpesaEnabled as unknown as jest.Mock,
  stkPush: stkPush as unknown as jest.Mock,
  stkQuery: stkQuery as unknown as jest.Mock,
};
const settle = settleCardPayment as unknown as jest.Mock;

const db = prisma as unknown as {
  invoice: { findFirst: jest.Mock; findUnique: jest.Mock };
  cardPayment: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

const ORG_ID = "org_1";
const INVOICE_ID = "inv_1";
const REFERENCE = "POS1001-MPESA-abcd1234";
const CHECKOUT_ID = "ws_CO_191020261000001";
const PHONE = "254712345678";

/** The stored sale exactly as `startMpesaPosPayment` reads it. */
function invoiceFor(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoiceNumber: "POS-1001",
    total: 1000,
    paidAmount: 0,
    currency: "KES",
    status: "SENT",
    ...overrides,
  };
}

/** A PENDING M-PESA row waiting for Safaricom to answer the prompt. */
function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cp_1",
    reference: REFERENCE,
    invoiceId: INVOICE_ID,
    organizationId: ORG_ID,
    amountCents: 100000,
    currency: "KES",
    email: PHONE,
    provider: "MPESA",
    status: "PENDING",
    providerRef: CHECKOUT_ID,
    ...overrides,
  };
}

const openInput = {
  invoiceId: INVOICE_ID,
  organizationId: ORG_ID,
  phone: "0712345678",
};

beforeEach(() => {
  jest.clearAllMocks();
  // The query spacing window is wall-clock state that would otherwise leak
  // from one case into the next; tests run back-to-back in milliseconds.
  resetMpesaPosQueryThrottle();
  // The push needs an HTTPS callback (Daraja's rule), so tests state one
  // explicitly rather than depending on whatever the machine has set.
  process.env.MPESA_CALLBACK_URL = "https://kazios.test/api/v1/webhooks/mpesa";
  gateway.isMpesaEnabled.mockReturnValue(true);
  gateway.stkPush.mockResolvedValue({
    checkoutRequestId: CHECKOUT_ID,
    merchantRequestId: "mr_1",
    customerMessage: "Check your phone for the M-PESA prompt",
  });
  gateway.stkQuery.mockResolvedValue({
    state: "SUCCESS",
    receipt: "SFH123456789",
    amountShillings: 1000,
    paidAt: "2026-10-19T10:45:30Z",
  });
  db.invoice.findFirst.mockResolvedValue(invoiceFor());
  db.cardPayment.findFirst.mockResolvedValue(null);
  db.cardPayment.findUnique.mockResolvedValue(pendingRow());
  db.cardPayment.create.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: "cp_1",
  }));
  db.cardPayment.update.mockResolvedValue({});
  settle.mockResolvedValue({
    alreadySettled: false,
    reference: REFERENCE,
    amountCents: 100000,
    currency: "KES",
  });
});

describe("opening the prompt at the till", () => {
  it("charges the invoice's outstanding balance, never a figure from the browser", async () => {
    // The request body carries a phone number and nothing else. The amount is
    // read from the stored invoice, so no caller can ask Safaricom for a
    // different number than the sale states.
    await startMpesaPosPayment(openInput);

    expect(db.cardPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: INVOICE_ID,
          organizationId: ORG_ID,
          amountCents: 100000,
          currency: "KES",
          provider: "MPESA",
          status: "PENDING",
        }),
      })
    );
    const push = gateway.stkPush.mock.calls[0][0];
    expect(push.amountShillings).toBe(1000);
    expect(push.phone).toBe(PHONE);
    expect(push.reference).toMatch(/^POS1001-MPESA-[0-9a-f]{8}$/);
    expect(push.callbackUrl).toContain("https://");
  });

  it("pushes only what is still owed on a split sale", async () => {
    // KES 700 of this sale was tendered in cash at the counter and is already
    // in paidAmount, so the prompt asks for the KES 300 remainder — never the
    // full total a second time.
    db.invoice.findFirst.mockResolvedValue(invoiceFor({ paidAmount: 700 }));

    await startMpesaPosPayment(openInput);

    expect(db.cardPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 30000 }),
      })
    );
    expect(gateway.stkPush.mock.calls[0][0].amountShillings).toBe(300);
  });

  it("refuses a sale that is already fully paid rather than charging it twice", async () => {
    db.invoice.findFirst.mockResolvedValue(invoiceFor({ paidAmount: 1000, status: "PAID" }));

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "INVOICE_ALREADY_PAID",
    });
    expect(db.cardPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a balance that is not whole shillings, naming the exact figure", async () => {
    // M-PESA has no subunit. KES 99.50 is refused by name with the amount
    // shown, never rounded — charging a different number than the invoice
    // states is the substitution this system must never permit.
    db.invoice.findFirst.mockResolvedValue(invoiceFor({ total: 99.5 }));

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "MPESA_NOT_WHOLE_SHILLINGS",
      message: expect.stringContaining("99.50"),
    });
    expect(db.cardPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses before any row exists when M-PESA is not configured", async () => {
    gateway.isMpesaEnabled.mockReturnValue(false);

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "MPESA_NOT_CONFIGURED",
    });
    expect(db.cardPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a phone number Daraja would reject", async () => {
    await expect(
      startMpesaPosPayment({ ...openInput, phone: "not-a-number" })
    ).rejects.toMatchObject({ code: "MPESA_PHONE_INVALID" });
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a callback that is not HTTPS before anything is written", async () => {
    delete process.env.MPESA_CALLBACK_URL;
    process.env.API_URL = "http://localhost:4000";

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "MPESA_CALLBACK_UNSAFE",
    });
    expect(db.cardPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a sale that is not in Kenyan shillings", async () => {
    db.invoice.findFirst.mockResolvedValue(invoiceFor({ currency: "USD" }));

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "MPESA_CURRENCY",
    });
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("404s an invoice that belongs to another organisation", async () => {
    // The lookup is scoped, so a foreign invoice id is a plain not-found
    // before any amount is computed or any prompt considered.
    db.invoice.findFirst.mockResolvedValue(null);

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("reuses the prompt already in flight instead of sending a second charge", async () => {
    db.cardPayment.findFirst.mockResolvedValue(pendingRow());

    const result = await startMpesaPosPayment(openInput);

    expect(result.reference).toBe(REFERENCE);
    expect(result.checkoutRequestId).toBe(CHECKOUT_ID);
    expect(gateway.stkPush).not.toHaveBeenCalled();
    expect(db.cardPayment.create).not.toHaveBeenCalled();
  });

  it("supersedes a prompt opened for a different balance rather than retargeting it", async () => {
    // The balance changed since this prompt opened. The old row is kept as the
    // record of the attempt (marked failed, never silently reused) and a fresh
    // push goes out for the real current balance.
    db.cardPayment.findFirst.mockResolvedValue(pendingRow({ amountCents: 50000 }));

    await startMpesaPosPayment(openInput);

    const superseded = db.cardPayment.update.mock.calls[0][0];
    expect(superseded.where).toEqual({ id: "cp_1" });
    expect(superseded.data.status).toBe("FAILED");
    expect(db.cardPayment.create).toHaveBeenCalledTimes(1);
    expect(gateway.stkPush).toHaveBeenCalledTimes(1);
    expect(gateway.stkPush.mock.calls[0][0].amountShillings).toBe(1000);
  });

  it("keeps the failed attempt on record when Safaricom refuses the push", async () => {
    gateway.stkPush.mockRejectedValue(new MpesaError("M-PESA did not accept the request", 502));

    await expect(startMpesaPosPayment(openInput)).rejects.toMatchObject({
      code: "MPESA_UNAVAILABLE",
    });
    const update = db.cardPayment.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(update.data.failureReason).toBeTruthy();
  });
});

describe("confirming the payment at the till", () => {
  it("settles only after Safaricom confirms, through the one settle path", async () => {
    // The whole design in one assertion: the question is asked, keyed on the
    // CheckoutRequestID stored at push time, and the answer settles the invoice
    // through `settleCardPayment` — the same function the card rail uses, so
    // paid-amount arithmetic has exactly one implementation.
    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(gateway.stkQuery).toHaveBeenCalledWith(CHECKOUT_ID);
    expect(settle).toHaveBeenCalledWith(
      REFERENCE,
      expect.objectContaining({ providerRef: "SFH123456789" }),
      "success"
    );
    expect(result).toMatchObject({
      status: "SUCCESS",
      settled: true,
      reference: REFERENCE,
    });
    expect(db.cardPayment.update).not.toHaveBeenCalled();
  });

  it("refuses a card reference pressed against this route", async () => {
    // The two rails never settle each other's rows, however the reference got
    // here — and the refusal happens before Daraja is asked anything.
    db.cardPayment.findUnique.mockResolvedValue(pendingRow({ provider: "PAYSTACK" }));

    await expect(confirmMpesaPosPayment(REFERENCE)).rejects.toMatchObject({
      code: "WRONG_PAYMENT_RAIL",
    });
    expect(gateway.stkQuery).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers an already-settled payment without asking Safaricom again", async () => {
    db.cardPayment.findUnique.mockResolvedValue(
      pendingRow({ status: "SUCCESS", providerRef: "SFH123456789" })
    );

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result).toMatchObject({ status: "SUCCESS", settled: true });
    expect(gateway.stkQuery).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("reports a prompt that never reached Safaricom without querying", async () => {
    // The push failed at open time and the row kept no CheckoutRequestID, so
    // there is nothing to ask about. Nothing has been charged.
    db.cardPayment.findUnique.mockResolvedValue(
      pendingRow({ providerRef: null, status: "FAILED" })
    );

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result.settled).toBe(false);
    // A row that can never resolve is marked so: the till stops polling
    // instead of asking a question that no future answer will change.
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/never sent/i);
    expect(gateway.stkQuery).not.toHaveBeenCalled();
  });

  it("changes nothing while the provider has not decided", async () => {
    // The customer may still be staring at the prompt. "Not yet" is not "no",
    // and it is certainly not "yes".
    gateway.stkQuery.mockResolvedValue({ state: "PENDING" });

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result).toMatchObject({ status: "PENDING", settled: false });
    expect(db.cardPayment.update).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("marks the attempt failed and settles nothing when the prompt was cancelled", async () => {
    // Result code 1032 is "the customer cancelled". The failure is written so
    // the till's history reads truthfully, and no money moves.
    gateway.stkQuery.mockResolvedValue({
      state: "FAILED",
      resultCode: 1032,
      resultDesc: "Request cancelled by user",
    });

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result).toMatchObject({ status: "FAILED", settled: false });
    expect(result.message).toMatch(/cancelled/i);
    const update = db.cardPayment.update.mock.calls[0][0];
    expect(update.data.status).toBe("FAILED");
    expect(settle).not.toHaveBeenCalled();
  });

  it("refuses an amount Safaricom confirms differently from what was pushed", async () => {
    // Money must not be recorded against an invoice it was not collected for.
    gateway.stkQuery.mockResolvedValue({
      state: "SUCCESS",
      receipt: "SFH999999999",
      amountShillings: 999,
      paidAt: null,
    });

    await expect(confirmMpesaPosPayment(REFERENCE)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("binds on the CheckoutRequestID when the query carries no amount metadata", async () => {
    // Daraja's query often reports no metadata. The CheckoutRequestID is
    // itself the binding: it names the one push opened with this exact
    // balance, so success on that key is success for that amount.
    gateway.stkQuery.mockResolvedValue({
      state: "SUCCESS",
      receipt: "SFH111111111",
      amountShillings: null,
      paidAt: null,
    });

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result.settled).toBe(true);
    expect(settle).toHaveBeenCalledWith(
      REFERENCE,
      expect.objectContaining({ providerRef: "SFH111111111" }),
      "success"
    );
  });

  it("leaves everything alone when the provider cannot be reached", async () => {
    // Nobody has been proven to have paid, so nothing about the sale changes.
    // The answer is a pending the cashier can keep waiting with — an error
    // here would read like a rejection of the payment rather than a failure
    // to ask.
    gateway.stkQuery.mockRejectedValue(new MpesaError("M-PESA could not be reached", 502));

    const result = await confirmMpesaPosPayment(REFERENCE);

    expect(result).toMatchObject({
      status: "PENDING",
      settled: false,
      retryable: true,
    });
    expect(result.message).toMatch(/nothing has been charged/i);
    expect(db.cardPayment.update).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("still surfaces a server that has lost its M-PESA configuration", async () => {
    // Reachability problems are a pending the cashier waits through; a missing
    // configuration is a fact about this server and must be shown.
    gateway.stkQuery.mockRejectedValue(
      new MpesaError("M-PESA is not configured on this server", 503)
    );

    await expect(confirmMpesaPosPayment(REFERENCE)).rejects.toMatchObject({
      code: "MPESA_NOT_CONFIGURED",
    });
    expect(db.cardPayment.update).not.toHaveBeenCalled();
  });

  it("keeps one trip to Daraja per spacing window", async () => {
    // The poll and a returning cashier arrive together; only one of them
    // earns a question. The second is answered from the window — a pending,
    // never an error, and never a second wire call.
    gateway.stkQuery.mockResolvedValue({ state: "PENDING" });

    const first = await confirmMpesaPosPayment(REFERENCE);
    const second = await confirmMpesaPosPayment(REFERENCE);

    expect(gateway.stkQuery).toHaveBeenCalledTimes(1);
    expect(first.settled).toBe(false);
    expect(second).toMatchObject({
      status: "PENDING",
      settled: false,
      retryable: true,
    });
  });

  it("404s a reference nothing knows about", async () => {
    db.cardPayment.findUnique.mockResolvedValue(null);

    await expect(confirmMpesaPosPayment("missing-ref")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(gateway.stkQuery).not.toHaveBeenCalled();
  });
});
