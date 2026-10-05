import {
  getEntitlements,
  hasFeature,
  invalidateEntitlements,
  isAtLimit,
  loadCoreFeatureKeys,
  readLimits,
  resolveStatus,
  statusAllowsUse,
  assertFeature,
  assertWithinLimit,
} from "./entitlements";
import { prisma } from "../lib/prisma";
import { LIMIT_KEYS, SUBSCRIPTION_STATUS, UNLIMITED } from "@kazios/types";
import { periodStartFor, FOREVER_PERIOD_START } from "./usage";

/**
 * The rules this system is judged on, tested without a database or a payment provider.
 *
 * The provider is not what is under test. What is under test is everything this system
 * decides on its own: what a business may do, how much of it it may do, what happens to
 * a subscription when a date passes while nothing is watching, and whether an allowance is
 * ever enforced from anything a browser said.
 *
 * Those are the failures that reach a real shop as a real loss, and none of them need a
 * live gateway to prove.
 */

jest.mock("../lib/prisma", () => ({
  prisma: {
    subscription: { findUnique: jest.fn(), findMany: jest.fn() },
    entitlementOverride: { findMany: jest.fn() },
    feature: { findMany: jest.fn() },
    plan: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { count: jest.fn() },
    branch: { count: jest.fn() },
    product: { count: jest.fn() },
    usageRecord: { findUnique: jest.fn() },
  },
}));

const db = prisma as unknown as {
  subscription: { findUnique: jest.Mock; findMany: jest.Mock };
  entitlementOverride: { findMany: jest.Mock };
  feature: { findMany: jest.Mock };
  plan: { findMany: jest.Mock; findUnique: jest.Mock };
  user: { count: jest.Mock };
  branch: { count: jest.Mock };
  product: { count: jest.Mock };
  usageRecord: { findUnique: jest.Mock };
};

const ORG = "org_1";

/** A subscription row as Prisma returns it, on the Community plan. */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "ACTIVE",
    billingInterval: "monthly",
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    endsAt: null,
    planPriceId: null,
    plan: {
      key: "community",
      name: "Community",
      description: "Free forever",
      isFree: true,
      trialDays: 0,
      features: [] as { featureKey: string }[],
      limits: [] as { key: string; value: number; source: string; unit: string; period: string }[],
    },
    planPrice: null,
    pendingPlan: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Every mock is given a default here rather than being set per test. `clearMocks` resets
  // recorded calls but keeps implementations, so a row set in one test would otherwise
  // leak into the next and make a passing assertion prove nothing. This suite is about
  // plans and dates, and a leaked expired subscription turns every check green for the
  // wrong reason.
  db.subscription.findUnique.mockResolvedValue(subscriptionRow());
  db.plan.findMany.mockResolvedValue([]);
  db.entitlementOverride.findMany.mockResolvedValue([]);
  db.user.count.mockResolvedValue(1);
  db.branch.count.mockResolvedValue(1);
  db.product.count.mockResolvedValue(0);
  db.usageRecord.findUnique.mockResolvedValue({ quantity: 0 });

  // The cache is per process and keyed by organization, so it is cleared between tests or
  // one test's plan is remembered by the next.
  invalidateEntitlements();
});

describe("what a subscription's status really is", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");

  it("reports a paid period that has not ended as active", () => {
    const status = resolveStatus(
      {
        status: "ACTIVE",
        trialEndsAt: null,
        currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
        graceEndsAt: null,
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it("reports a free plan as active forever, because nothing was ever paid for", () => {
    // Community has no period end at all. Reading that as "expired" because the date is
    // missing would take the till away from every free customer in the world.
    const status = resolveStatus(
      { status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null, graceEndsAt: null },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it("keeps a business working during grace after a failed renewal", () => {
    const status = resolveStatus(
      {
        status: "ACTIVE",
        trialEndsAt: null,
        currentPeriodEnd: new Date("2026-06-10T00:00:00.000Z"),
        graceEndsAt: new Date("2026-06-20T00:00:00.000Z"),
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.GRACE);
    // Grace exists precisely so a declined card does not stop a shop serving customers.
    expect(statusAllowsUse(status)).toBe(true);
  });

  it("expires only once grace has also run out", () => {
    const status = resolveStatus(
      {
        status: "ACTIVE",
        trialEndsAt: null,
        currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
        graceEndsAt: new Date("2026-06-08T00:00:00.000Z"),
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    expect(statusAllowsUse(status)).toBe(false);
  });

  it("ignores a stale stored status that the dates have overtaken", () => {
    // This is the failure that matters most: nothing reloads the page on the night a card
    // fails, so a sweep that has not run must not let an expired business keep paying
    // features. The dates, not the stored string, decide.
    const status = resolveStatus(
      {
        status: "ACTIVE",
        trialEndsAt: null,
        currentPeriodEnd: new Date("2026-05-01T00:00:00.000Z"),
        graceEndsAt: null,
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it("does not revive a cancelled subscription because its period is still open", () => {
    const status = resolveStatus(
      {
        status: "CANCELED",
        trialEndsAt: null,
        currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
        graceEndsAt: null,
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it("reports a running trial as trialing even though the period has been set", () => {
    const status = resolveStatus(
      {
        status: "TRIALING",
        trialEndsAt: new Date("2026-06-20T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-06-20T00:00:00.000Z"),
        graceEndsAt: null,
      },
      now
    );
    expect(status).toBe(SUBSCRIPTION_STATUS.TRIALING);
    expect(statusAllowsUse(status)).toBe(true);
  });
});

describe("features: what a business may do", () => {
  it("grants the whole core to an expired subscription", async () => {
    // The open source promise. A lapsed payment must narrow what is paid for; it must
    // never take a business's till, stock or customers away, and must never delete
    // anything. This is the test that stops a future change quietly doing both.
    db.feature.findMany.mockResolvedValue([
      { key: "core_pos" },
      { key: "core_products" },
      { key: "core_customers" },
    ]);
    await loadCoreFeatureKeys();

    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        status: "ACTIVE",
        currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z"),
        plan: {
          ...subscriptionRow().plan,
          key: "starter",
          name: "Starter",
          isFree: false,
          features: [{ featureKey: "multi_branch" }],
        },
      })
    );

    const snapshot = await getEntitlements(ORG, {
      now: new Date("2026-06-15T00:00:00.000Z"),
      skipCache: true,
    });

    expect(snapshot.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
    expect(snapshot.isActive).toBe(false);
    // The paid capability goes.
    expect(hasFeature(snapshot, "multi_branch")).toBe(false);
    // The core stays.
    expect(hasFeature(snapshot, "core_pos")).toBe(true);
    expect(hasFeature(snapshot, "core_customers")).toBe(true);
  });

  it("refuses a capability the plan does not include, and names the way out", async () => {
    db.plan.findMany.mockResolvedValue([
      { key: "starter", name: "Starter" },
      { key: "business", name: "Business" },
    ]);
    const snapshot = await getEntitlements(ORG, { skipCache: true });

    expect(hasFeature(snapshot, "multi_branch")).toBe(false);
    await expect(assertFeature(snapshot, "multi_branch")).rejects.toMatchObject({
      statusCode: 403,
      code: "FEATURE_NOT_INCLUDED",
    });
  });

  it("explains an expired subscription differently from a missing capability", async () => {
    // "Upgrade to unlock multiple branches" is the wrong advice for a business whose card
    // failed last week. They need to fix a payment, not buy a bigger plan.
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({ currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z") })
    );
    const snapshot = await getEntitlements(ORG, {
      now: new Date("2026-06-15T00:00:00.000Z"),
      skipCache: true,
    });

    await expect(assertFeature(snapshot, "multi_branch")).rejects.toMatchObject({
      code: "SUBSCRIPTION_INACTIVE",
    });
  });

  it("lets a business through when its plan does include the capability", async () => {
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          key: "starter",
          name: "Starter",
          isFree: false,
          features: [{ featureKey: "multi_branch" }],
        },
      })
    );
    const snapshot = await getEntitlements(ORG, { skipCache: true });
    await expect(assertFeature(snapshot, "multi_branch")).resolves.toBeUndefined();
  });

  it("applies an administrator's override on top of a plan", async () => {
    db.entitlementOverride.findMany.mockResolvedValue([
      { kind: "FEATURE", featureKey: "api_access", limitKey: null, value: true },
      { kind: "LIMIT", featureKey: null, limitKey: "users", value: 50 },
    ]);
    db.subscription.findUnique.mockResolvedValue(subscriptionRow());
    const snapshot = await getEntitlements(ORG, { skipCache: true });

    expect(hasFeature(snapshot, "api_access")).toBe(true);
    expect(snapshot.limits.get("users")?.value).toBe(50);
    expect(snapshot.limits.get("users")?.origin).toBe("OVERRIDE");
  });
});

describe("limits: how much a business may do", () => {
  it("counts a counted limit from live rows rather than a stored number", async () => {
    // The number shown in billing is the number of rows that exist. A counter that had
    // drifted would refuse a customer who is within their allowance.
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          limits: [
            {
              key: LIMIT_KEYS.BRANCHES,
              value: 3,
              source: "COUNTED",
              unit: "count",
              period: "never",
            },
          ],
        },
      })
    );
    db.branch.count.mockResolvedValue(2);

    const readings = await readLimits(await getEntitlements(ORG, { skipCache: true }));
    const branches = readings.find(r => r.key === LIMIT_KEYS.BRANCHES)!;

    expect(branches.used).toBe(2);
    expect(branches.limit).toBe(3);
    expect(branches.remaining).toBe(1);
    expect(branches.atLimit).toBe(false);
  });

  it("warns before the allowance is gone, not only after", async () => {
    // A business told at 80% has time to upgrade. One refused at 100% with no warning has a
    // till that stopped working mid market.
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          limits: [
            {
              key: LIMIT_KEYS.MONTHLY_TRANSACTIONS,
              value: 100,
              source: "METERED",
              unit: "per_month",
              period: "monthly",
            },
          ],
        },
      })
    );
    db.usageRecord.findUnique.mockResolvedValue({ quantity: 80 });

    const readings = await readLimits(await getEntitlements(ORG, { skipCache: true }));
    const tx = readings.find(r => r.key === LIMIT_KEYS.MONTHLY_TRANSACTIONS)!;

    expect(tx.warning).toBe(true);
    expect(tx.atLimit).toBe(false);
  });

  it("refuses work that would take a business past an allowance", async () => {
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          limits: [
            {
              key: LIMIT_KEYS.BRANCHES,
              value: 1,
              source: "COUNTED",
              unit: "count",
              period: "never",
            },
          ],
        },
      })
    );
    db.branch.count.mockResolvedValue(1);
    db.plan.findMany.mockResolvedValue([{ key: "starter", name: "Starter" }]);

    const snapshot = await getEntitlements(ORG, { skipCache: true });
    await expect(assertWithinLimit(snapshot, LIMIT_KEYS.BRANCHES)).rejects.toMatchObject({
      statusCode: 409,
      code: "LIMIT_REACHED",
      details: expect.objectContaining({ limit: LIMIT_KEYS.BRANCHES, used: 1, limit_value: 1 }),
    });
  });

  it("allows work that still fits", async () => {
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          limits: [
            { key: LIMIT_KEYS.USERS, value: 5, source: "COUNTED", unit: "count", period: "never" },
          ],
        },
      })
    );
    db.user.count.mockResolvedValue(2);

    const snapshot = await getEntitlements(ORG, { skipCache: true });
    await expect(assertWithinLimit(snapshot, LIMIT_KEYS.USERS)).resolves.toBeUndefined();
  });

  it("never refuses against an unlimited allowance, however much is used", async () => {
    db.subscription.findUnique.mockResolvedValue(
      subscriptionRow({
        plan: {
          ...subscriptionRow().plan,
          key: "enterprise",
          name: "Enterprise",
          limits: [
            {
              key: LIMIT_KEYS.USERS,
              value: UNLIMITED,
              source: "COUNTED",
              unit: "count",
              period: "never",
            },
          ],
        },
      })
    );
    db.user.count.mockResolvedValue(10_000);

    const snapshot = await getEntitlements(ORG, { skipCache: true });
    await expect(assertWithinLimit(snapshot, LIMIT_KEYS.USERS)).resolves.toBeUndefined();

    const readings = await readLimits(snapshot);
    expect(readings[0].unlimited).toBe(true);
    expect(readings[0].atLimit).toBe(false);
  });

  it("keeps a business already over a limit working, rather than deleting what it has", () => {
    // The downgrade case. A business drops from Business to Community holding three
    // branches, on a plan that allows one. It keeps all three and cannot add a fourth.
    // isAtLimit is what makes that survivable, and it is deliberately "still over".
    const limit = {
      key: "branches",
      value: 1,
      source: "COUNTED",
      unit: "count",
      period: "never",
      origin: "PLAN" as const,
    };
    expect(isAtLimit(limit, 3)).toBe(true);
    expect(isAtLimit(limit, 1)).toBe(true);
    expect(isAtLimit(limit, 0)).toBe(false);
  });

  it("sets no ceiling for a limit the plan does not mention", async () => {
    db.subscription.findUnique.mockResolvedValue(subscriptionRow());
    const snapshot = await getEntitlements(ORG, { skipCache: true });
    // Not "zero" and not "one": a plan that says nothing about a limit imposes none.
    await expect(assertWithinLimit(snapshot, "ai_requests")).resolves.toBeUndefined();
  });
});

describe("usage periods", () => {
  it("resets a monthly allowance on the first of the month, in UTC", () => {
    const start = periodStartFor("monthly", new Date("2026-06-15T12:34:56.000Z"));
    expect(start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("keeps a never resetting allowance in one bucket forever", () => {
    // Two records for the same key and period would make the counter read as two running
    // totals instead of one, which is how a storage allowance quietly stops counting.
    expect(periodStartFor("never").toISOString()).toBe(FOREVER_PERIOD_START.toISOString());
  });
});
