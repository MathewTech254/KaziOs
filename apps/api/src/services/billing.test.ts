import { prisma } from "../lib/prisma";
import { confirmCheckout, openCheckout } from "./billing";
import { initializeTransaction, isPaystackEnabled, verifyTransaction } from "../lib/paystack";

/**
 * The money half of subscription billing, tested without a Paystack account.
 *
 * Every test here is about the same question: what does this system do when somebody says
 * a payment happened? A provider that was never asked, a browser that says it paid, a
 * charge for the wrong amount, and a webhook that arrives twice. Those are the paths that
 * hand out a paid plan for nothing, and none of them need a live gateway to prove.
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

jest.mock("../lib/paystack", () => ({
  isPaystackEnabled: jest.fn(() => true),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  PaystackError: class PaystackError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const gateway = {
  isPaystackEnabled: isPaystackEnabled as unknown as jest.Mock,
  initializeTransaction: initializeTransaction as unknown as jest.Mock,
  verifyTransaction: verifyTransaction as unknown as jest.Mock,
};

const db = prisma as unknown as {
  subscription: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
  };
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

/** A Starter checkout waiting for the provider to confirm it. */
function pendingPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    reference: REFERENCE,
    organizationId: "org_1",
    planId: "plan_starter",
    amountCents: 1900,
    currency: "USD",
    kind: "INITIAL",
    billingInterval: "monthly",
    status: "PENDING",
    plan: { key: "starter", name: "Starter", trialDays: 14 },
    ...overrides,
  };
}

/** A Paystack transaction that reports the money arrived. */
function successfulCharge(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    reference: REFERENCE,
    amount: 1900,
    currency: "USD",
    transaction_id: 778899,
    paid_at: "2026-06-15T10:00:00.000Z",
    authorization: { card_type: "visa", last4: "4242" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  gateway.isPaystackEnabled.mockReturnValue(true);
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
    // `activateSubscription` reads the plan it is leaving, to tell an upgrade from a
    // downgrade for the ledger. Community sorts below Starter.
    plan: { id: "plan_community", key: "community", name: "Community", sortOrder: 1 },
  });
  db.subscription.update.mockResolvedValue({});
  db.subscription.create.mockResolvedValue({ id: "sub_1" });
  db.subscription.findMany.mockResolvedValue([]);
  db.subscriptionEvent.create.mockResolvedValue({});
  db.organization.update.mockResolvedValue({});
  db.plan.findFirst.mockResolvedValue({ id: "plan_community" });
  // The plan being bought, shaped as getPlanByKey returns it. `status` matters: activating a
  // plan that is not ACTIVE is refused, which is how an archived plan stops being sold
  // without a special case in the code.
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
          prices: [{ id: "price_1", interval: "monthly", amountCents: 1900, currency: "USD" }],
          limits: [],
          features: [],
        }
      : { id: "plan_business", key: "business", status: "ACTIVE", sortOrder: 3 }
  );
  db.planPrice.findFirst.mockResolvedValue({ id: "price_1", amountCents: 1900, currency: "USD" });
  db.entitlementOverride.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe("opening checkout", () => {
  it("charges the price stored on the plan, not one the request asked for", async () => {
    // The amount is never taken from the caller. A price a browser sends is a price the
    // customer chooses, and trusting one means charging whatever you are told.
    gateway.initializeTransaction.mockResolvedValue({
      authorization_url: "https://checkout.paystack.com/abc",
      access_code: "code",
      reference: REFERENCE,
    });

    await openCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      email: "owner@shop.test",
    });

    const sentToGateway = gateway.initializeTransaction.mock.calls[0][0];
    expect(sentToGateway.amountInCents).toBe(1900);
    expect(db.subscriptionPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: 1900 }) })
    );
  });

  it("activates nothing, because nothing has been paid yet", async () => {
    gateway.initializeTransaction.mockResolvedValue({
      authorization_url: "https://checkout.paystack.com/abc",
      access_code: "code",
      reference: REFERENCE,
    });

    await openCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      email: "owner@shop.test",
    });

    // The subscription row is not touched. A response body is not a payment.
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses to open a checkout for a plan with no price", async () => {
    // Enterprise is quoted, not sold. A row with an amount of 0 would read as "free" to
    // anything that sums prices, so the absence of a price is what blocks the sale.
    db.planPrice.findFirst.mockResolvedValue(null);

    await expect(
      openCheckout({
        organizationId: "org_1",
        planKey: "enterprise",
        interval: "monthly",
        email: "owner@shop.test",
      })
    ).rejects.toMatchObject({ code: "PRICE_NOT_AVAILABLE" });
  });

  it("refuses to open a checkout for a free plan", async () => {
    db.planPrice.findFirst.mockResolvedValue({ id: "p", amountCents: 0, currency: "USD" });

    await expect(
      openCheckout({
        organizationId: "org_1",
        planKey: "community",
        interval: "monthly",
        email: "owner@shop.test",
      })
    ).rejects.toMatchObject({ code: "PLAN_IS_FREE" });
  });

  it("refuses when payments are not configured, rather than writing a dead row", async () => {
    gateway.isPaystackEnabled.mockReturnValue(false);

    await expect(
      openCheckout({
        organizationId: "org_1",
        planKey: "starter",
        interval: "monthly",
        email: "owner@shop.test",
      })
    ).rejects.toMatchObject({ code: "PAYMENTS_NOT_CONFIGURED" });

    expect(db.subscriptionPayment.create).not.toHaveBeenCalled();
  });

  it("reuses an open checkout rather than charging twice for one intent", async () => {
    // A double tap on "Upgrade" must not become two charges.
    db.subscriptionPayment.findFirst.mockResolvedValue({
      reference: REFERENCE,
      authorizationUrl: "https://checkout.paystack.com/existing",
      amountCents: 1900,
      currency: "USD",
    });

    const result = await openCheckout({
      organizationId: "org_1",
      planKey: "starter",
      interval: "monthly",
      email: "owner@shop.test",
      idempotencyKey: "upgrade-intent-1",
    });

    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/existing");
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
});

describe("confirming a payment", () => {
  it("activates the plan only after the provider confirms the money", async () => {
    gateway.verifyTransaction.mockResolvedValue(successfulCharge());

    const result = await confirmCheckout(REFERENCE);

    expect(gateway.verifyTransaction).toHaveBeenCalledWith(REFERENCE);
    expect(result.settled).toBe(true);
    expect(db.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org_1" },
        data: expect.objectContaining({ planId: "plan_starter", status: "ACTIVE" }),
      })
    );
  });

  it("records a real payment as paid, with the provider's own reference", async () => {
    gateway.verifyTransaction.mockResolvedValue(successfulCharge());

    await confirmCheckout(REFERENCE);

    const updated = db.subscriptionPayment.update.mock.calls[0][0];
    expect(updated.data.status).toBe("SUCCESS");
    expect(updated.data.providerRef).toBe("778899");
    // Only the brand and four digits are kept. The full number and token belong to the
    // provider and storing them here would make this table worth stealing.
    expect(db.subscription.update.mock.calls[0][0].data.paymentMethodLast4).toBe("4242");
  });

  it("does nothing at all when the provider says the charge failed", async () => {
    gateway.verifyTransaction.mockResolvedValue(
      successfulCharge({ status: "failed", amount: 1900 })
    );

    const result = await confirmCheckout(REFERENCE);

    expect(result.settled).toBe(false);
    // The plan is untouched. A declined card must not leave a half applied upgrade.
    const subscriptionUpdates = db.subscription.update.mock.calls.filter(
      (call: any[]) => call[0].data?.planId
    );
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it("refuses a charge for a different amount than the plan price", async () => {
    // The substitution this system must not permit: a real charge, for the wrong number,
    // granting a plan.
    gateway.verifyTransaction.mockResolvedValue(successfulCharge({ amount: 1 }));

    await expect(confirmCheckout(REFERENCE)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses a charge in a different currency", async () => {
    gateway.verifyTransaction.mockResolvedValue(successfulCharge({ currency: "NGN" }));

    await expect(confirmCheckout(REFERENCE)).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH",
    });
  });

  it("leaves the business where it was when the provider cannot be reached", async () => {
    // Nobody has been proven to have paid, so nobody has been proven to have upgraded.
    gateway.verifyTransaction.mockRejectedValue(new Error("network down"));

    await expect(confirmCheckout(REFERENCE)).rejects.toMatchObject({
      code: "PAYSTACK_UNAVAILABLE",
    });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("does nothing the second time a webhook arrives for the same payment", async () => {
    // A replayed webhook must not extend the period a second time, which would hand a
    // customer two months for one charge.
    gateway.verifyTransaction.mockResolvedValue(successfulCharge());
    db.subscriptionPayment.findUnique.mockResolvedValue(pendingPayment({ status: "SUCCESS" }));

    const result = await confirmCheckout(REFERENCE);

    expect(result.settled).toBe(true);
    expect(result.message).toMatch(/already applied/i);
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it("clears a stale grace period the moment money arrives", async () => {
    // A business that pays up after a failed renewal must not be expired next month for
    // a grace date nobody ever cleared.
    gateway.verifyTransaction.mockResolvedValue(successfulCharge());

    await confirmCheckout(REFERENCE);

    expect(db.subscription.update.mock.calls[0][0].data.graceEndsAt).toBeNull();
  });

  it("writes a ledger entry saying who paid for what", async () => {
    gateway.verifyTransaction.mockResolvedValue(successfulCharge());

    await confirmCheckout(REFERENCE);

    expect(db.subscriptionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: expect.stringMatching(/ACTIVATED|UPGRADED/) }),
      })
    );
  });
});
