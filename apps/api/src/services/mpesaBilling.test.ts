import { prisma } from "../lib/prisma";
import { confirmMpesaCheckout, openMpesaCheckout } from "./mpesaBilling";
import { isMpesaEnabled, MpesaError, stkPush, stkQuery } from "../lib/mpesa";

/**
 * The M-PESA half of subscription billing, tested without a Safaricom account.
 *
 * The same questions as `billing.test.ts`, in M-PESA's vocabulary: what does this
 * system do when somebody says a prompt was answered? A provider that was never
 * asked, a callback that cannot be trusted (Daraja signs nothing), a charge for
 * the wrong amount, a confirm pressed twice. None of those need live Daraja
 * credentials to prove, which is the point: the credentials arrive later, the
 * invariants are tested now.
 *
 * `lib/mpesa` is partially mocked — `normalizeMsisdn` and `describeStkFailure`
 * stay real, because they are pure logic and their behaviour is part of what is
 * being asserted. The network halves (`stkPush`, `stkQuery`) are the doubles.
 */

jest.mock("../lib/prisma", () => ({
  prisma: {
    subscription: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    subscriptionPayment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    subscriptionEvent: { create: jest.fn() },
    organization: { update: jest.fn() },
    plan: { findFirst: jest.fn(), findUnique: jest.fn() },
    planPrice: { findFirst: jest.fn() },
    entitlementOverride: { findMany: jest.fn() },
    feature: { findMany: jest.fn() },
    user: { count: jest.fn() },
    branch: { count: jest.fn() },
    product: { count: jest.fn() },
    usageRecord: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

// Loaded because `mpesaBilling` imports `currentPaymentKind` from `./billing`.
// The card gateway itself is never touched by these tests, which is exactly the
// separation the feature promises.
jest.mock("../lib/paystack", () => ({
  isPaystackEnabled: jest.fn(() => true),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  PaystackError: class PaystackError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = "PaystackError";
    }
  },
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

const db = prisma as unknown as {
  subscription: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; findMany: jest.Mock };
  subscriptionPayment: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  subscriptionEvent: { create: jest.Mock };
  organization: { update: jest.Mock };
  plan: { findFirst: jest.Mock; findUnique: jest.Mock };
  planPrice: { findFirst: jest.Mock };
  entitlementOverride: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const REFERENCE = "SUB-STARTER-abcd1234";
const CHECKOUT_ID = "ws_CO_10102026102533993";

/** A Starter M-PESA checkout waiting for Safaricom to answer the prompt. */
function pendingPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    reference: REFERENCE,
    organizationId: "org_1",
    planId: "plan_starter",
    amountCents: 149900,
    currency: "KES",
    kind: "INITIAL",
    billingInterval: "monthly",
    status: "PENDING",
    provider: "MPESA",
    providerRef: CHECKOUT_ID,
    plan: { key: "starter", name: "Starter", trialDays: 14 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
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
    amountShillings: 1499,
    paidAt: "20261010102530",
  });
  db.subscriptionPayment.findUnique.mockResolvedValue(pendingPayment());
  db.subscriptionPayment.findFirst.mockResolvedValue(null);
  db.subscriptionPayment.create.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: "pay_1",
  }));
  db.subscriptionPayment.update.mockResolvedValue({});
  db.subscription.findUnique.mockResolvedValue({
    id: "sub_1",
    planId: "plan_community",
    trialEndsAt: null,
    status: "ACTIVE",
    plan: { id: "plan_community", key: "community", name: "Community", sortOrder: 1 },
  });
  db.subscription.update.mockResolvedValue({});
  db.subscription.create.mockResolvedValue({ id: "sub_1" });
  db.subscription.findMany.mockResolvedValue([]);
  db.subscriptionEvent.create.mockResolvedValue({});
  db.organization.update.mockResolvedValue({});
  db.plan.findFirst.mockResolvedValue({ id: "plan_community" });
  // The plan being bought, shaped as `getPlanByKey` returns it.
  db.plan.findUnique.mockImplementation(async ({ where }: any) =>
    where?.key === "starter"
      ? {
          id: "plan_starter",
          key: "starter",
          name: "Starter",
          status: "ACTIVE",
          visibility: "PUBLIC",
          isFree: false,
          trialDays: 14,
          sortOrder: 2,
          prices: [{ id: "price_1", interval: "monthly", amountCents: 149900, currency: "KES" }],
          limits: [],
          features: [],
        }
      : { id: "plan_business", key: "business", status: "ACTIVE", sortOrder: 3 }
  );
  db.planPrice.findFirst.mockResolvedValue({
    id: "price_1",
    interval: "monthly",
    amountCents: 149900,
    currency: "KES",
  });
  db.entitlementOverride.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe("opening an M-PESA checkout", () => {
  it("charges the KES price row, not anything the request asked for", async () => {
    // The amount is never taken from the caller, and it is whole shillings worked
    // out from the plan's own row: KES 1,499 = 149900 cents = 1499 to Daraja.
    await openMpesaCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      phone: "0712345678",
    });

    expect(db.subscriptionPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountCents: 149900,
          currency: "KES",
          provider: "MPESA",
          status: "PENDING",
        }),
      })
    );
    const sentToGateway = gateway.stkPush.mock.calls[0][0];
    expect(sentToGateway.amountShillings).toBe(1499);
    expect(sentToGateway.phone).toBe("254712345678");
    expect(sentToGateway.callbackUrl).toContain("/api/v1/webhooks/mpesa");
  });

  it("activates nothing, because nothing has been paid yet", async () => {
    await openMpesaCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      phone: "0712345678",
    });

    // The subscription row is not touched. A response body is not a payment.
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses when M-PESA is not configured, rather than writing a dead row", async () => {
    gateway.isMpesaEnabled.mockReturnValue(false);

    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "0712345678",
      })
    ).rejects.toMatchObject({ code: "MPESA_NOT_CONFIGURED" });

    expect(db.subscriptionPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a phone number Daraja would reject", async () => {
    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "not-a-number",
      })
    ).rejects.toMatchObject({ code: "MPESA_PHONE_INVALID" });

    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses to open when the callback Safaricom would post to is not HTTPS", async () => {
    // Daraja rejects the push itself for a non-HTTPS CallBackURL, so this fails
    // before a row exists and says what to do about it instead of surfacing an
    // opaque 400 from the provider.
    delete process.env.MPESA_CALLBACK_URL;
    process.env.API_URL = "http://localhost:4000";

    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "0712345678",
      })
    ).rejects.toMatchObject({ code: "MPESA_CALLBACK_UNSAFE" });

    expect(db.subscriptionPayment.create).not.toHaveBeenCalled();
    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a plan with no KES price rather than inventing an exchange rate", async () => {
    db.planPrice.findFirst.mockResolvedValue(null);

    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "0712345678",
      })
    ).rejects.toMatchObject({ code: "MPESA_PRICE_UNAVAILABLE" });

    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("refuses a price that is not whole shillings instead of rounding it", async () => {
    db.planPrice.findFirst.mockResolvedValue({
      id: "price_1",
      interval: "monthly",
      amountCents: 149999,
      currency: "KES",
    });

    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "0712345678",
      })
    ).rejects.toMatchObject({ code: "MPESA_WHOLE_SHILLINGS" });

    expect(gateway.stkPush).not.toHaveBeenCalled();
  });

  it("marks the row failed and rethrows when Safaricom refuses the push", async () => {
    // Nothing was charged, and the attempt is kept as a failed row rather than
    // deleted: it is the record of what the customer tried to do.
    gateway.stkPush.mockRejectedValue(new MpesaError("M-PESA did not accept the request", 502));

    await expect(
      openMpesaCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        phone: "0712345678",
      })
    ).rejects.toMatchObject({ code: "MPESA_UNAVAILABLE" });

    const updated = db.subscriptionPayment.update.mock.calls[0][0];
    expect(updated.data.status).toBe("FAILED");
    expect(updated.data.failureReason).toBeTruthy();
  });

  it("reuses an open prompt rather than sending two for one intent", async () => {
    // A double tap on "Upgrade" must not become two prompts and two charges.
    db.subscriptionPayment.findFirst.mockResolvedValue({
      id: "pay_1",
      reference: REFERENCE,
      providerRef: CHECKOUT_ID,
      amountCents: 149900,
      currency: "KES",
    });

    const result = await openMpesaCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      phone: "0712345678",
      idempotencyKey: "upgrade-intent-1",
    });

    expect(result.reference).toBe(REFERENCE);
    expect(result.checkoutRequestId).toBe(CHECKOUT_ID);
    expect(gateway.stkPush).not.toHaveBeenCalled();
    expect(db.subscriptionPayment.create).not.toHaveBeenCalled();
  });
});

describe("confirming an M-PESA payment", () => {
  it("activates the plan only after Safaricom confirms the money", async () => {
    // The whole design in one assertion: the question is asked, keyed on the
    // CheckoutRequestID stored at push time, and the answer is what settles it.
    const result = await confirmMpesaCheckout(REFERENCE);

    expect(gateway.stkQuery).toHaveBeenCalledWith(CHECKOUT_ID);
    expect(result.settled).toBe(true);
    expect(db.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org_1" },
        data: expect.objectContaining({ planId: "plan_starter", status: "ACTIVE" }),
      })
    );
  });

  it("records the payment as paid, with the M-PESA receipt as the reference", async () => {
    await confirmMpesaCheckout(REFERENCE);

    const updated = db.subscriptionPayment.update.mock.calls[0][0];
    expect(updated.data.status).toBe("SUCCESS");
    // The receipt is the permanent record of the charge; the CheckoutRequestID
    // was only ever the key to ask the question with.
    expect(updated.data.providerRef).toBe("SFH123456789");
  });

  it("changes nothing while the provider has not decided", async () => {
    // The customer may still be staring at the prompt. "Not yet" is not "no",
    // and it is certainly not "yes".
    gateway.stkQuery.mockResolvedValue({ state: "PENDING" });

    const result = await confirmMpesaCheckout(REFERENCE);

    expect(result.settled).toBe(false);
    expect(result.status).toBe("PENDING");
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
    expect(db.subscriptionPayment.update).not.toHaveBeenCalled();
  });

  it("marks the attempt failed and grants nothing when the prompt was cancelled", async () => {
    // Result code 1032 is "the customer cancelled". The failure is written so
    // the history reads truthfully, and the plan is untouched.
    gateway.stkQuery.mockResolvedValue({
      state: "FAILED",
      resultCode: 1032,
      resultDesc: "Request cancelled by user",
    });

    const result = await confirmMpesaCheckout(REFERENCE);

    expect(result.settled).toBe(false);
    expect(result.message).toMatch(/cancelled/i);
    const updated = db.subscriptionPayment.update.mock.calls[0][0];
    expect(updated.data.status).toBe("FAILED");
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it("refuses a confirmed amount that does not match the plan price", async () => {
    // The substitution this system must not permit: a real charge, for the
    // wrong number, granting a plan.
    gateway.stkQuery.mockResolvedValue({
      state: "SUCCESS",
      receipt: "SFH123456789",
      amountShillings: 500,
      paidAt: "20261010102530",
    });

    await expect(confirmMpesaCheckout(REFERENCE)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it("does nothing the second time a confirm arrives for the same payment", async () => {
    // A replayed callback, a double-pressed check button, and a returning
    // browser all race; none of them may push the renewal date out twice.
    db.subscriptionPayment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCESS", providerRef: "SFH123456789" })
    );

    const result = await confirmMpesaCheckout(REFERENCE);

    expect(result.settled).toBe(true);
    expect(result.message).toMatch(/already applied/i);
    // Settled rows hold the receipt, not the CheckoutRequestID, so there is
    // nothing left to ask Safaricom and nothing is asked.
    expect(gateway.stkQuery).not.toHaveBeenCalled();
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it("refuses to settle a card checkout pressed against this route", async () => {
    // The two rails never settle each other's rows, however the reference got
    // here.
    db.subscriptionPayment.findUnique.mockResolvedValue(
      pendingPayment({ provider: "PAYSTACK" })
    );

    await expect(confirmMpesaCheckout(REFERENCE)).rejects.toMatchObject({
      code: "WRONG_PAYMENT_RAIL",
    });
    expect(gateway.stkQuery).not.toHaveBeenCalled();
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("leaves the business where it was when the provider cannot be reached", async () => {
    // Nobody has been proven to have paid, so nobody has been proven to have
    // upgraded. The row stays pending and the answer is an error, not a "no".
    gateway.stkQuery.mockRejectedValue(new MpesaError("M-PESA could not be reached", 502));

    await expect(confirmMpesaCheckout(REFERENCE)).rejects.toMatchObject({
      code: "MPESA_UNAVAILABLE",
    });
    expect(db.subscriptionPayment.update).not.toHaveBeenCalled();
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it("reports a row whose prompt never reached Safaricom without querying", async () => {
    // The push failed at open time and the row kept no CheckoutRequestID, so
    // there is nothing to ask about. Nothing has been charged.
    db.subscriptionPayment.findUnique.mockResolvedValue(
      pendingPayment({ providerRef: null, status: "FAILED" })
    );

    const result = await confirmMpesaCheckout(REFERENCE);

    expect(result.settled).toBe(false);
    expect(result.message).toMatch(/never sent/i);
    expect(gateway.stkQuery).not.toHaveBeenCalled();
  });
});




