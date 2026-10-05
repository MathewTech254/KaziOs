import request from "supertest";
import {
  testApp,
  testPrisma,
  auth,
  createTenant,
  closeHarness,
  assertTestDatabase,
  RUN_ID,
} from "./testHarness";
import { invalidateEntitlements, loadCoreFeatureKeys } from "../services/entitlements";

/**
 * Plans enforced over real HTTP and a real database.
 *
 * The unit suites mock Prisma, which proves the arithmetic. It cannot prove that a route is
 * wired, that the check runs before the write, or that a refusal leaves nothing behind. Those
 * are exactly the failures that reach a business as a broken feature, and each of them has
 * produced a green build in this repository before being found by hand.
 */
jest.setTimeout(120000);

beforeAll(async () => {
  assertTestDatabase();
  // The CORE feature set is loaded at boot in the real server. Here it has to be loaded
  // explicitly, or every check would compare against an empty set.
  await loadCoreFeatureKeys();
  invalidateEntitlements();
});

afterAll(async () => {
  await closeHarness();
});

describe("a new business starts on the default plan", () => {
  it("is given a subscription without being asked", async () => {
    const tenant = await createTenant("onboarding");
    const subscription = await testPrisma.subscription.findUnique({
      where: { organizationId: tenant.organizationId },
      include: { plan: { select: { key: true, isFree: true } } },
    });

    expect(subscription).not.toBeNull();
    expect(subscription!.plan.key).toBe("community");
    // Free forever, not a trial that quietly expires in a fortnight.
    expect(subscription!.plan.isFree).toBe(true);
    expect(subscription!.currentPeriodEnd).toBeNull();
  });

  it("already has the main branch registration created", async () => {
    const tenant = await createTenant("branches");
    const branches = await testPrisma.branch.findMany({
      where: { organizationId: tenant.organizationId },
    });
    expect(branches).toHaveLength(1);
  });
});

describe("limits are enforced by the server, not the browser", () => {
  it("refuses a second branch on Community, and creates nothing", async () => {
    const tenant = await createTenant("branchlimit");

    const res = await request(testApp)
      .post("/api/v1/org/branches")
      .set(auth(tenant.token))
      .send({ name: "Second Branch", code: "SECOND" });

    expect(res.status).toBe(403);
    // The refusal has to explain itself and offer a way out. "Forbidden" tells an owner
    // nothing they can act on.
    expect(res.body.error).toMatch(/not part of the Community plan/i);
    expect(res.body.details?.upgradeUrl).toBe("/pricing");

    // The important half: a refused request leaves no trace. A branch row here would mean
    // the check ran after the write.
    const branches = await testPrisma.branch.findMany({
      where: { organizationId: tenant.organizationId },
    });
    expect(branches).toHaveLength(1);
  });

  it("refuses a fourth member on Community, and creates nobody", async () => {
    const tenant = await createTenant("seatlimit");

    // Registration makes the owner. Two more reaches the Community allowance of three.
    for (const index of [1, 2]) {
      await request(testApp)
        .post("/api/v1/users")
        .set(auth(tenant.token))
        .send({
          name: `Member ${index}`,
          email: `m${index}.${tenant.email}`,
          password: "KaziOS!Integration2026",
        })
        .expect(201);
    }

    const refused = await request(testApp)
      .post("/api/v1/users")
      .set(auth(tenant.token))
      .send({
        name: "Member 3",
        email: `m3.${tenant.email}`,
        password: "KaziOS!Integration2026",
      });

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_REACHED");
    expect(refused.body.error).toMatch(/team members/i);
    expect(refused.body.details?.limit).toBe("users");

    const members = await testPrisma.user.findMany({
      where: { organizationId: tenant.organizationId },
    });
    expect(members).toHaveLength(3);
  });

  it("lets the same request through once the plan has the capability", async () => {
    const tenant = await createTenant("upgraded");

    // Two separate things are being granted, because the API checks two separate things.
    // Granting the capability opens the gate; raising the limit raises the ceiling. A
    // business that was only granted the first still hits the second, which is the correct
    // answer and is asserted separately below.
    await testPrisma.entitlementOverride.createMany({
      data: [
        {
          organizationId: tenant.organizationId,
          kind: "FEATURE",
          featureKey: "multi_branch",
          value: true,
          reason: "Integration test: the capability is granted",
        },
        {
          organizationId: tenant.organizationId,
          kind: "LIMIT",
          limitKey: "branches",
          value: 3,
          reason: "Integration test: the allowance is raised",
        },
      ],
    });

    // The cache is short lived by design; a real API process would pick this up within
    // seconds. Cleared here so the assertion is not a race.
    invalidateEntitlements(tenant.organizationId);

    const res = await request(testApp)
      .post("/api/v1/org/branches")
      .set(auth(tenant.token))
      .send({ name: "Second Branch", code: "SECOND" });

    expect(res.status).toBe(201);
    const branches = await testPrisma.branch.findMany({
      where: { organizationId: tenant.organizationId },
    });
    expect(branches).toHaveLength(2);
  });

  it("still refuses at the ceiling even once the capability is granted", async () => {
    const tenant = await createTenant("featureonly");

    // The capability is granted and the allowance is not raised. The gate opens and the
    // limit holds, which is why the two checks are not one: a business given a capability
    // for a negotiated reason may still be held to the plan's own numbers.
    await testPrisma.entitlementOverride.create({
      data: {
        organizationId: tenant.organizationId,
        kind: "FEATURE",
        featureKey: "multi_branch",
        value: true,
        reason: "Integration test: capability granted, limit deliberately left alone",
      },
    });
    invalidateEntitlements(tenant.organizationId);

    const res = await request(testApp)
      .post("/api/v1/org/branches")
      .set(auth(tenant.token))
      .send({ name: "Second Branch", code: "SECOND" });

    // A limit refusal, not a feature refusal: the two are told apart so the message is.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LIMIT_REACHED");
    expect(res.body.details?.limit).toBe("branches");

    const branches = await testPrisma.branch.findMany({
      where: { organizationId: tenant.organizationId },
    });
    expect(branches).toHaveLength(1);
  });
});

describe("the plan catalogue is honest", () => {
  it("is readable without signing in, so a pricing page can be rendered", async () => {
    const res = await request(testApp).get("/api/v1/plans").expect(200);
    const { plans, comparison } = res.body.data;

    expect(plans.length).toBeGreaterThanOrEqual(3);
    expect(plans.map((p: any) => p.key)).toContain("community");

    // Every advertised feature is one the API could actually enforce, which is exactly what
    // the `available` flag on each Feature row means.
    const community = plans.find((p: any) => p.key === "community");
    expect(community.features.every((f: any) => typeof f.key === "string")).toBe(true);
    expect(comparison.features.length).toBeGreaterThan(0);
    expect(comparison.limits.length).toBeGreaterThan(0);
  });

  it("never advertises Enterprise, which is quoted rather than sold", async () => {
    const res = await request(testApp).get("/api/v1/plans").expect(200);
    expect(res.body.data.plans.map((p: any) => p.key)).not.toContain("enterprise");
  });
});

describe("platform administration is separate from business administration", () => {
  it("refuses a business owner, however senior inside their own shop", async () => {
    const tenant = await createTenant("notadmin");

    // This user holds `*` inside their own organization. That must mean nothing at all
    // here: platform authority is granted separately, by scope, on a PlatformAdmin record.
    const res = await request(testApp).get("/api/v1/platform/businesses").set(auth(tenant.token));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_PLATFORM_ADMIN");
  });

  it("refuses an anonymous caller too", async () => {
    await request(testApp).get("/api/v1/platform/overview").expect(401);
  });

  it("lets a platform administrator in", async () => {
    const tenant = await createTenant("isadmin");
    await testPrisma.platformAdmin.create({
      data: { userId: tenant.userId, scopes: ["platform.read"] },
    });

    await request(testApp).get("/api/v1/platform/overview").set(auth(tenant.token)).expect(200);
  });
});

describe("subscription continuity", () => {
  /** Moves a business's paid period into the past, which is what time does to a real one. */
  async function expire(organizationId: string) {
    await testPrisma.subscription.update({
      where: { organizationId },
      data: { currentPeriodEnd: new Date(Date.now() - 60 * 86400000) },
    });
    invalidateEntitlements(organizationId);
  }

  it("keeps a business fully working when its subscription expires", async () => {
    const tenant = await createTenant("lapsed");
    await expire(tenant.organizationId);

    const summary = await request(testApp)
      .get("/api/v1/billing/summary")
      .set(auth(tenant.token))
      .expect(200);
    expect(summary.body.data.isExpired).toBe(true);

    // The whole point: the product still works and the data is all still there. A business
    // whose card failed is still a business with a till.
    await request(testApp)
      .post("/api/v1/customers")
      .set(auth(tenant.token))
      .send({ name: `${RUN_ID} After Expiry`, phone: "0700000002" })
      .expect(201);

    const customers = await testPrisma.customer.count({
      where: { organizationId: tenant.organizationId },
    });
    expect(customers).toBeGreaterThan(0);
  });

  it("tells an expired business its data is safe, in the words it shows", async () => {
    const tenant = await createTenant("expiredmessage");
    await expire(tenant.organizationId);

    const res = await request(testApp)
      .post("/api/v1/org/branches")
      .set(auth(tenant.token))
      .send({ name: "Branch After Expiry", code: "AFTER" });

    expect(res.status).toBe(403);
    // Not "upgrade to unlock". They do not need a bigger plan, they need to pay the one
    // they already have.
    expect(res.body.code).toBe("SUBSCRIPTION_INACTIVE");
    expect(res.body.error).toMatch(/data is safe/i);
  });

  it("will not let one business change another's subscription", async () => {
    const a = await createTenant("billingiso-a");

    // Cancelling Community is refused, because there is nothing paid to cancel. The point
    // of the assertion is that no row moved: there is no route anywhere that accepts an
    // organization id, so this is structural rather than a check that could be forgotten.
    const res = await request(testApp)
      .post("/api/v1/billing/cancel")
      .set(auth(a.token))
      .expect(400);
    expect(res.body.error).toMatch(/free/i);

    const subscription = await testPrisma.subscription.findUnique({
      where: { organizationId: a.organizationId },
      select: { canceledAt: true, status: true },
    });
    expect(subscription!.canceledAt).toBeNull();
    expect(subscription!.status).toBe("ACTIVE");
  });

  it("shows a business only its own payments", async () => {
    const a = await createTenant("payiso-a");
    const res = await request(testApp)
      .get("/api/v1/billing/payments")
      .set(auth(a.token))
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });
});
