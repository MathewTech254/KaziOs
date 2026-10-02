import request from "supertest";
import {
  testApp,
  testPrisma,
  auth,
  createTenant,
  cleanupRun,
  closeHarness,
  assertTestDatabase,
} from "./testHarness";

/**
 * Whole-workflow tests over real HTTP and a real database.
 *
 * These cover the failures that cost a business money and that a mocked unit test
 * structurally cannot see: a route that was never wired, a permission that was not
 * actually applied, and one tenant reading another's data. Each of those produced a
 * green build in this repository before it was found by hand.
 */
jest.setTimeout(120000);

beforeAll(() => {
  assertTestDatabase();
});
afterAll(async () => {
  await closeHarness();
});

/**
 * Total debits minus total credits for one organization, read straight from the ledger.
 *
 * Asserted as a number rather than inferred from a response body, because a route can
 * return a well formed sale while the accounting behind it is unbalanced, and that is
 * precisely the failure a bookkeeper discovers months later.
 */
async function ledgerDifference(organizationId: string): Promise<number> {
  const row = await testPrisma.$queryRaw<{ diff: number | string }[]>`
    SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS diff
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    WHERE je."organizationId" = ${organizationId}
  `;
  return Number(row[0]?.diff ?? 0);
}

describe("tenant isolation", () => {
  let a: Awaited<ReturnType<typeof createTenant>>;
  let b: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    a = await createTenant("alpha");
    b = await createTenant("beta");
  });

  it("gives each new business its own organization", () => {
    expect(a.organizationId).toBeTruthy();
    expect(a.organizationId).not.toBe(b.organizationId);
  });

  it("never lists another business's customers", async () => {
    const created = await request(testApp)
      .post("/api/v1/customers")
      .set(auth(a.token))
      .send({ name: "Alpha Only Customer", phone: "0700000001" });
    expect(created.status).toBe(201);

    const seenByB = await request(testApp).get("/api/v1/customers").set(auth(b.token)).expect(200);
    // Business B must not see A's customer by any route, including the plain list.
    expect(seenByB.body.data.map((c: { name: string }) => c.name)).not.toContain(
      "Alpha Only Customer"
    );
  });

  it("refuses to read another business's customer by id", async () => {
    const mine = await request(testApp)
      .post("/api/v1/customers")
      .set(auth(a.token))
      .send({ name: "Alpha Private" });
    const id = mine.body.data.id;

    // A direct id is the classic IDOR: if this returns the record, B can read anything.
    const res = await request(testApp).get(`/api/v1/customers/${id}`).set(auth(b.token));
    expect(res.status).toBe(404);
  });

  it("refuses to let one business edit or delete another's customer", async () => {
    const mine = await request(testApp)
      .post("/api/v1/customers")
      .set(auth(a.token))
      .send({ name: "Alpha Owned" });
    const id = mine.body.data.id;

    await request(testApp)
      .patch(`/api/v1/customers/${id}`)
      .set(auth(b.token))
      .send({ name: "Hijacked" })
      .expect(404);
    await request(testApp).delete(`/api/v1/customers/${id}`).set(auth(b.token)).expect(404);

    // The record must be untouched, not merely inaccessible.
    const still = await request(testApp)
      .get(`/api/v1/customers/${id}`)
      .set(auth(a.token))
      .expect(200);
    expect(still.body.data.name).toBe("Alpha Owned");
  });

  it("keeps each business's expense categories separate", async () => {
    const mine = await request(testApp).get("/api/v1/expenses/categories").set(auth(a.token));
    const rentA = mine.body.data.find((c: { name: string }) => c.name === "Rent");

    // Attaching B's expense to A's category must be refused, not silently accepted.
    const res = await request(testApp).post("/api/v1/expenses").set(auth(b.token)).send({
      vendorName: "Cross Tenant",
      amount: 100,
      expenseDate: new Date().toISOString(),
      categoryId: rentA.id,
    });
    expect(res.status).toBe(400);
  });
});

describe("authentication and authorization", () => {
  let owner: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    owner = await createTenant("authowner");
  });

  it("refuses a request with no token", async () => {
    await request(testApp).get("/api/v1/customers").expect(401);
  });

  it("refuses a forged token", async () => {
    await request(testApp).get("/api/v1/customers").set(auth("not-a-real-token")).expect(401);
  });

  it("rejects the wrong password without confirming the account exists", async () => {
    // The response must not distinguish a wrong password from an unknown address, or
    // the endpoint becomes a way to discover who has an account here.
    const res = await request(testApp)
      .post("/api/v1/auth/login")
      .send({ email: owner.email, password: "WrongPassword!123" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/no such|not found|unknown/i);
  });

  it("stops serving a session once it is signed out", async () => {
    const throwaway = await createTenant("logout");
    await request(testApp).get("/api/v1/customers").set(auth(throwaway.token)).expect(200);
    await request(testApp).post("/api/v1/auth/logout").set(auth(throwaway.token)).expect(200);
    // A token that still verifies cryptographically must be useless once revoked.
    await request(testApp).get("/api/v1/customers").set(auth(throwaway.token)).expect(401);
  });

  it("denies a permission the role does not hold, and writes nothing", async () => {
    const limited = await createTenant("limited");
    const role = await testPrisma.role.findFirst({
      where: { organizationId: limited.organizationId, type: "OWNER" },
    });
    await testPrisma.role.update({
      where: { id: role!.id },
      data: { permissions: ["pos.sale", "customers.view"] },
    });

    // The token issued at registration still carries the old permissions, so sign in
    // again to pick up the narrowed role. A permission change that only takes effect on
    // the next sign in is a property worth stating rather than assuming.
    const login = await request(testApp)
      .post("/api/v1/auth/login")
      .send({ email: limited.email, password: "KaziOS!Integration2026" });
    const cashierToken = login.body.data.token;

    await request(testApp).get("/api/v1/customers").set(auth(cashierToken)).expect(200);

    // expenses.manage was never granted, so this must be refused even though the
    // caller owns the organization.
    const denied = await request(testApp)
      .post("/api/v1/expenses/categories")
      .set(auth(cashierToken))
      .send({ name: "Should Not Exist" });
    expect(denied.status).toBe(403);

    // A status check alone is not enough: prove nothing was written.
    const rows = await testPrisma.expenseCategory.findMany({
      where: { organizationId: limited.organizationId, name: "Should Not Exist" },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("a sale, end to end", () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let productId: string;
  let warehouseId: string;

  beforeAll(async () => {
    tenant = await createTenant("seller");
    const context = await request(testApp).get("/api/v1/pos/context").set(auth(tenant.token));
    const branch = context.body.data.branches.find((b: { isMain: boolean }) => b.isMain);
    warehouseId = context.body.data.warehouses.find(
      (w: { branchId: string }) => w.branchId === branch.id
    ).id;

    const product = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Integration Widget",
        sku: `IT-${Date.now().toString(36)}`,
        costPrice: 100,
        sellingPrice: 200,
        minStock: 1,
        trackStock: true,
      });
    expect(product.status).toBe(201);
    productId = product.body.data.id;
  });

  it("refuses to sell what is not in stock", async () => {
    const res = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 5, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 1000, tenderedAmount: 1000 }],
      });
    // No stock has been received, so the sale must be refused rather than go negative.
    // 409 rather than 400: the request was well formed, it conflicts with the stock on
    // hand, and the till needs to re-read the cart rather than treat it as a typo.
    expect(res.status).toBe(409);

    // The refusal must leave stock at zero rather than a phantom negative balance.
    const refused = await testPrisma.inventory.findFirst({ where: { productId, warehouseId } });
    expect(refused ? refused.quantity : 0).toBe(0);
  });

  it("refuses cash that does not cover the total", async () => {
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 200, tenderedAmount: 10 }],
      })
      .expect(400);
  });

  it("sells, moves stock, takes payment and leaves the ledger balanced", async () => {
    const adjustment = await request(testApp)
      .post("/api/v1/inventory/adjustments")
      .set(auth(tenant.token))
      .send({
        productId,
        warehouseId,
        quantity: 10,
        adjustmentType: "INCREASE",
        reason: "Opening stock",
      });
    expect(adjustment.status).toBe(201);

    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 3, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 600, tenderedAmount: 1000 }],
        idempotencyKey: `integration-${Date.now()}`,
      });
    expect(sale.status).toBe(201);
    expect(sale.body.data.invoice.total).toBe(600);
    expect(sale.body.data.changeAmount).toBe(400);

    // Stock: 10 received, 3 sold, 7 left. Read from the database, not the response.
    const stock = await testPrisma.inventory.findFirst({ where: { productId, warehouseId } });
    expect(stock?.quantity).toBe(7);

    const payments = await testPrisma.payment.findMany({
      where: { organizationId: tenant.organizationId, status: "SUCCESS" },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(600);

    // The ledger is what a bookkeeper audits, so it must balance to the cent.
    expect(await ledgerDifference(tenant.organizationId)).toBe(0);
  });

  it("is not charged twice when the same sale is submitted again", async () => {
    const key = `idem-${Date.now()}`;
    const payload = {
      customerId: null,
      items: [{ productId, quantity: 1, discountAmount: 0 }],
      discountAmount: 0,
      payments: [{ provider: "CASH", methodType: "cash", amount: 200, tenderedAmount: 200 }],
      idempotencyKey: key,
    };
    const first = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payload);
    expect(second.status).toBe(200);
    // The retry must return the original sale rather than take the money again.
    expect(second.body.data.idempotent).toBe(true);
    expect(second.body.data.invoice.id).toBe(first.body.data.invoice.id);

    const invoices = await testPrisma.invoice.findMany({
      where: { organizationId: tenant.organizationId, idempotencyKey: key },
    });
    expect(invoices).toHaveLength(1);
  });
});

describe("expenses and the ledger", () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;

  beforeAll(async () => {
    tenant = await createTenant("expenser");
  });

  it("rejects an amount that is not money", async () => {
    for (const amount of [0, -50]) {
      const res = await request(testApp)
        .post("/api/v1/expenses")
        .set(auth(tenant.token))
        .send({ vendorName: "Invalid", amount, expenseDate: new Date().toISOString() });
      expect(res.status).toBe(400);
    }
  });

  it("records an expense, posts a balanced entry, and reverses it on void", async () => {
    const created = await request(testApp).post("/api/v1/expenses").set(auth(tenant.token)).send({
      vendorName: "Landlord",
      amount: 45000,
      expenseDate: new Date().toISOString(),
      paymentMethod: "MPESA",
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    expect(await ledgerDifference(tenant.organizationId)).toBe(0);

    const voided = await request(testApp)
      .post(`/api/v1/expenses/${id}/void`)
      .set(auth(tenant.token))
      .send({ reason: "Recorded against the wrong supplier" });
    expect(voided.status).toBe(200);

    // The reversal must leave the books balanced, not merely mark the row.
    expect(await ledgerDifference(tenant.organizationId)).toBe(0);

    // And the row survives: a financial record is corrected, never erased.
    const row = await testPrisma.expense.findUnique({ where: { id } });
    expect(row?.status).toBe("VOIDED");
    expect(row?.amount).toBe(45000);
  });

  it("refuses a void with no reason", async () => {
    const created = await request(testApp)
      .post("/api/v1/expenses")
      .set(auth(tenant.token))
      .send({ vendorName: "No Reason", amount: 100, expenseDate: new Date().toISOString() });
    await request(testApp)
      .post(`/api/v1/expenses/${created.body.data.id}/void`)
      .set(auth(tenant.token))
      .send({})
      .expect(400);
  });

  it("refuses to void the same expense twice", async () => {
    const created = await request(testApp)
      .post("/api/v1/expenses")
      .set(auth(tenant.token))
      .send({ vendorName: "Twice", amount: 100, expenseDate: new Date().toISOString() });
    const id = created.body.data.id;
    await request(testApp)
      .post(`/api/v1/expenses/${id}/void`)
      .set(auth(tenant.token))
      .send({ reason: "First" })
      .expect(200);
    await request(testApp)
      .post(`/api/v1/expenses/${id}/void`)
      .set(auth(tenant.token))
      .send({ reason: "Second" })
      .expect(409);
  });

  it("keeps a voided expense out of the totals while leaving it on the record", async () => {
    // Measured as a delta rather than an absolute, because the suite deliberately leaves
    // an unvoided expense behind in an earlier test. A total that assumes it is the only
    // one in the business would fail for reasons that have nothing to do with this test.
    const before = await request(testApp).get("/api/v1/expenses/summary").set(auth(tenant.token));
    const baseline = before.body.data.totalAmount;

    const created = await request(testApp).post("/api/v1/expenses").set(auth(tenant.token)).send({
      vendorName: "Still Counted",
      amount: 1234.56,
      expenseDate: new Date().toISOString(),
    });

    const counted = await request(testApp).get("/api/v1/expenses/summary").set(auth(tenant.token));
    expect(counted.body.data.totalAmount).toBeCloseTo(baseline + 1234.56, 2);

    await request(testApp)
      .post(`/api/v1/expenses/${created.body.data.id}/void`)
      .set(auth(tenant.token))
      .send({ reason: "Wrong amount" })
      .expect(200);

    // Voiding must give back exactly what recording took, no more and no less.
    const after = await request(testApp).get("/api/v1/expenses/summary").set(auth(tenant.token));
    expect(after.body.data.totalAmount).toBeCloseTo(baseline, 2);

    // Still reachable, because the record of what happened is the point.
    const listed = await request(testApp)
      .get("/api/v1/expenses?search=Still Counted")
      .set(auth(tenant.token));
    expect(listed.body.data).toHaveLength(1);
  });
});

describe("cleanup", () => {
  it("removes every row this run created", async () => {
    await cleanupRun();
    const left = await testPrisma.organization.findMany({
      where: { name: { startsWith: "itest-" } },
    });
    expect(left).toHaveLength(0);
  });
});
