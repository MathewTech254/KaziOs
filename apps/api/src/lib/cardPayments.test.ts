import { prisma } from "./prisma";
import {
  confirmCardPayment,
  paystackIsReady,
  settleCardPayment,
  startCardPayment,
} from "./cardPayments";
import {
  initializeTransaction,
  isPaystackEnabled,
  minimumChargeCents,
  verifyTransaction,
} from "./paystack";

/**
 * The money-moving half of card payments, tested without a Paystack account.
 *
 * The provider is mocked because it is not what is under test. What is under test is
 * everything this system decides on its own: whether a customer can be charged twice,
 * whether a failed attempt can mark an invoice paid, whether a payment for one amount
 * can be applied to a different invoice, and whether the amount on the till is the amount
 * the customer was actually asked for.
 *
 * Those are the failures that reach a real shop as a real loss, and none of them require
 * a live gateway to prove.
 */

jest.mock("./prisma", () => ({
  prisma: {
    invoice: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    cardPayment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

// The factory declares its own jest.fn()s rather than closing over a variable defined
// below it. Jest hoists every jest.mock call to the top of the file, so a factory that
// referenced an outer `const` would run before that const was initialised.
jest.mock("./paystack", () => ({
  isPaystackEnabled: jest.fn(() => true),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  minimumChargeCents: jest.fn((currency: string) => (currency === "KES" ? 300 : 100)),
  PaystackError: class PaystackError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

// Held as jest.fn() references rather than bound methods. Binding would satisfy the
// unbound-method lint rule but strip Jest's mock controls, so the assertions that prove
// the provider was never called would silently stop working.
// eslint-disable-next-line @typescript-eslint/unbound-method
const paystack = {
  isPaystackEnabled: isPaystackEnabled as unknown as jest.Mock,
  initializeTransaction: initializeTransaction as unknown as jest.Mock,
  verifyTransaction: verifyTransaction as unknown as jest.Mock,
  minimumChargeCents: minimumChargeCents as unknown as jest.Mock,
};

const db = prisma as unknown as {
  invoice: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  cardPayment: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  payment: { create: jest.Mock };
  $transaction: jest.Mock;
};

const REFERENCE = "INV-1001-abcd1234";

/** An invoice of KES 1,000 that nobody has paid yet. */
function unpaidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_1",
    invoiceNumber: "INV-1001",
    total: 1000,
    paidAmount: 0,
    currency: "KES",
    status: "SENT",
    organizationId: "org_1",
    ...overrides,
  };
}

/** An open card payment for KES 1,000, which is 100,000 pesewas. */
function pendingCard(overrides: Record<string, unknown> = {}) {
  return {
    reference: REFERENCE,
    invoiceId: "inv_1",
    organizationId: "org_1",
    amountCents: 100000,
    currency: "KES",
    status: "PENDING",
    authorizationUrl: "https://checkout.paystack.com/abc",
    email: "amina@shop.test",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  paystack.isPaystackEnabled.mockReturnValue(true);
  paystack.minimumChargeCents.mockImplementation((c: string) => (c === "KES" ? 300 : 100));
  db.$transaction.mockResolvedValue([]);
  db.payment.create.mockResolvedValue({});
  db.invoice.update.mockResolvedValue({});
  db.cardPayment.update.mockResolvedValue({});
  db.cardPayment.create.mockResolvedValue({});
});

describe("opening a card payment", () => {
  it("takes the amount from the invoice, never from the caller", async () => {
    // The request body carries only an invoice id and an email. If the amount could be
    // influenced by the request, a tampered till could charge a customer any number.
    db.invoice.findFirst.mockResolvedValue(unpaidInvoice());
    db.cardPayment.findFirst.mockResolvedValue(null);
    paystack.initializeTransaction.mockResolvedValue({
      authorization_url: "https://checkout.paystack.com/xyz",
      access_code: "code",
      reference: REFERENCE,
    });

    await startCardPayment({ invoiceId: "inv_1", organizationId: "org_1", email: "a@b.test" });

    expect(paystack.initializeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amountInCents: 100000, currency: "KES" })
    );
  });

  it("reuses an open payment so a double tap cannot charge twice", async () => {
    db.invoice.findFirst.mockResolvedValue(unpaidInvoice());
    db.cardPayment.findFirst.mockResolvedValue(pendingCard());

    const result = await startCardPayment({
      invoiceId: "inv_1",
      organizationId: "org_1",
      email: "a@b.test",
    });

    expect(result.reference).toBe(REFERENCE);
    // No second transaction means no second charge.
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    expect(db.cardPayment.create).not.toHaveBeenCalled();
  });

  it("refuses an amount below the provider's floor, before the customer is charged", async () => {
    db.invoice.findFirst.mockResolvedValue(unpaidInvoice({ total: 2 }));
    db.cardPayment.findFirst.mockResolvedValue(null);

    await expect(
      startCardPayment({ invoiceId: "inv_1", organizationId: "org_1", email: "a@b.test" })
    ).rejects.toThrow(/Card payments start at/);
    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it("refuses a cancelled invoice", async () => {
    db.invoice.findFirst.mockResolvedValue(unpaidInvoice({ status: "VOID" }));
    await expect(
      startCardPayment({ invoiceId: "inv_1", organizationId: "org_1", email: "a@b.test" })
    ).rejects.toThrow(/cancelled/);
  });

  it("reports the provider being down as a retryable gateway problem", async () => {
    db.invoice.findFirst.mockResolvedValue(unpaidInvoice());
    db.cardPayment.findFirst.mockResolvedValue(null);
    paystack.initializeTransaction.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      startCardPayment({ invoiceId: "inv_1", organizationId: "org_1", email: "a@b.test" })
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("is unavailable rather than half working when no key is configured", () => {
    paystack.isPaystackEnabled.mockReturnValue(false);
    expect(paystackIsReady()).toBe(false);
  });
});

describe("settling a confirmed payment", () => {
  it("marks the invoice paid and records the money once", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice());

    const result = await settleCardPayment(REFERENCE, { providerRef: "tx_1" }, "success");

    expect(result.alreadySettled).toBe(false);
    // KES 1,000 exactly covers the invoice.
    expect(db.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 1000, status: "PAID" }),
      })
    );
    expect(db.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 1000, status: "SUCCESS" }),
      })
    );
  });

  it("never charges a customer twice for one reference", async () => {
    // A webhook delivered twice, or a webhook plus the browser's confirm, must settle once.
    db.cardPayment.findUnique.mockResolvedValue(pendingCard({ status: "SUCCESS" }));
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice({ paidAmount: 1000, status: "PAID" }));

    const result = await settleCardPayment(REFERENCE, {}, "success");

    expect(result.alreadySettled).toBe(true);
    // The guard is only worth anything if it writes nothing.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("does not let a late event revive a payment that already failed", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard({ status: "FAILED" }));
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice());

    const result = await settleCardPayment(REFERENCE, {}, "success");

    expect(result.alreadySettled).toBe(true);
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("leaves the invoice untouched when the payment failed", async () => {
    // This is the assertion that matters most. A declined card that marks an invoice
    // paid is a shop handing over goods it has not been paid for.
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice());

    await settleCardPayment(REFERENCE, {}, "failed");

    const update = db.invoice.update.mock.calls[0][0];
    expect(update.data.paidAmount).toBe(0);
    expect(update.data.status).toBeUndefined();
    expect(db.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("marks a part payment part paid, not paid", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard({ amountCents: 40000 }));
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice());

    await settleCardPayment(REFERENCE, {}, "success");

    expect(db.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 400, status: "PARTIALLY_PAID" }),
      })
    );
  });

  it("adds a second payment to one invoice rather than replacing what is there", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard({ amountCents: 40000 }));
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice({ paidAmount: 600 }));

    await settleCardPayment(REFERENCE, {}, "success");

    // 600 already in, 400 more collected, 1000 total: fully paid and nothing lost.
    expect(db.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 1000, status: "PAID" }),
      })
    );
  });

  it("refuses to settle a reference it has never issued", async () => {
    db.cardPayment.findUnique.mockResolvedValue(null);
    await expect(settleCardPayment("made-up", {}, "success")).rejects.toThrow(/not found/i);
  });
});

describe("confirming with the provider", () => {
  it("settles on Paystack's own answer, not the browser's", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    db.invoice.findUnique.mockResolvedValue(unpaidInvoice());
    paystack.verifyTransaction.mockResolvedValue({
      status: "success",
      reference: REFERENCE,
      amount: 100000,
      currency: "KES",
      email: "a@b.test",
      transaction_id: 77,
      paid_at: "2026-10-02T10:00:00Z",
    });

    const result = await confirmCardPayment(REFERENCE);

    expect(result.settled).toBe(true);
    expect(db.invoice.update).toHaveBeenCalled();
  });

  it("refuses to record money that does not match the invoice", async () => {
    // The amount the provider confirms is authoritative. If it differs from what the
    // invoice says, something is wrong, and guessing which is right is how a shop ends
    // up serving a customer for free or collecting far too much.
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    paystack.verifyTransaction.mockResolvedValue({
      status: "success",
      reference: REFERENCE,
      amount: 1, // one hundredth of a shilling
      currency: "KES",
      email: "a@b.test",
      transaction_id: 78,
    });

    await expect(confirmCardPayment(REFERENCE)).rejects.toMatchObject({
      statusCode: 409,
      code: "AMOUNT_MISMATCH",
    });
    // Nothing was written, so the sale is simply left unpaid and can be retaken.
    expect(db.invoice.update).not.toHaveBeenCalled();
    expect(db.payment.create).not.toHaveBeenCalled();
  });

  it("refuses a payment confirmed in a different currency", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    paystack.verifyTransaction.mockResolvedValue({
      status: "success",
      reference: REFERENCE,
      amount: 100000,
      currency: "USD",
      email: "a@b.test",
      transaction_id: 79,
    });

    await expect(confirmCardPayment(REFERENCE)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
  });

  it("does not settle while the customer is still paying", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    paystack.verifyTransaction.mockResolvedValue({
      status: "ongoing",
      reference: REFERENCE,
      amount: 100000,
      currency: "KES",
      email: "a@b.test",
      transaction_id: 80,
    });

    const result = await confirmCardPayment(REFERENCE);

    // "ongoing" is not "failed", so the payment is left open for a later webhook.
    expect(result.settled).toBe(false);
    expect(result.status).toBe("ongoing");
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("records an abandoned attempt as failed so the till can be retaken", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard());
    db.cardPayment.update.mockResolvedValue({});
    paystack.verifyTransaction.mockResolvedValue({
      status: "abandoned",
      reference: REFERENCE,
      amount: 100000,
      currency: "KES",
      email: "a@b.test",
      transaction_id: 81,
    });

    const result = await confirmCardPayment(REFERENCE);

    expect(result.settled).toBe(false);
    expect(db.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("does not ask the provider twice once a payment has already settled", async () => {
    db.cardPayment.findUnique.mockResolvedValue(pendingCard({ status: "SUCCESS" }));

    const result = await confirmCardPayment(REFERENCE);

    expect(result.settled).toBe(true);
    // A repeat of a delivered webhook must not become a repeat call to Paystack either.
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
  });
});
