import request from "supertest";
import { createHmac } from "crypto";
import {
  testApp,
  testPrisma,
  auth,
  createTenant,
  cleanupRun,
  closeHarness,
  assertTestDatabase,
  RUN_ID,
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

describe("the dashboard", () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let other: Awaited<ReturnType<typeof createTenant>>;
  let productId: string;

  beforeAll(async () => {
    tenant = await createTenant("dash");
    other = await createTenant("dashother");

    // Registration already opens a warehouse on the main branch, so the POS context
    // supplies one rather than this test inventing a second way to create it.
    const context = await request(testApp).get("/api/v1/pos/context").set(auth(tenant.token));
    const branch = context.body.data.branches.find((b: { isMain: boolean }) => b.isMain);
    const warehouseId = context.body.data.warehouses.find(
      (w: { branchId: string }) => w.branchId === branch.id
    ).id;

    const product = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Dashboard Widget",
        sku: `DASH-${RUN_ID}`,
        costPrice: 400,
        sellingPrice: 1000,
        trackStock: true,
        minStock: 5,
      })
      .expect(201);
    productId = product.body.data.id;

    await request(testApp)
      .post("/api/v1/inventory/adjustments")
      .set(auth(tenant.token))
      .send({
        productId,
        warehouseId,
        quantity: 50,
        adjustmentType: "INCREASE",
        reason: "Opening stock",
      })
      .expect(201);

    // One sale and one expense, so profit is a subtraction with a non-zero answer.
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 2 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 2000, tenderedAmount: 2000 }],
        idempotencyKey: `dashboard-${RUN_ID}`,
      })
      .expect(201);

    await request(testApp)
      .post("/api/v1/expenses")
      .set(auth(tenant.token))
      .send({ vendorName: "Dashboard Fuel", amount: 500, expenseDate: new Date().toISOString() })
      .expect(201);
  });

  it("counts money that actually changed hands", async () => {
    const res = await request(testApp)
      .get("/api/v1/reports/dashboard")
      .set(auth(tenant.token))
      .expect(200);
    const { today, month } = res.body.data;

    // Read from the figures the endpoint computed, then checked against the sale's own
    // total. An endpoint that reports a plausible-looking but wrong number cannot be
    // caught by asserting that the number is a number.
    expect(today.revenue).toBeGreaterThan(0);
    expect(month.revenue).toBeGreaterThanOrEqual(today.revenue);
    expect(month.expenses).toBeGreaterThan(0);
    expect(month.transactions).toBeGreaterThan(0);
    // 2 units at a 1000 selling price, no tax category applied -> 2000.
    expect(month.revenue).toBeCloseTo(2000, 2);
    expect(month.profit).toBeCloseTo(month.revenue - month.expenses, 2);
  });

  it("agrees with the expense report it sits next to", async () => {
    const dashboard = await request(testApp)
      .get("/api/v1/reports/dashboard")
      .set(auth(tenant.token));
    const summary = await request(testApp).get("/api/v1/expenses/summary").set(auth(tenant.token));
    // Two screens showing different "expenses this month" is the exact contradiction
    // that makes an owner stop trusting both of them.
    expect(dashboard.body.data.month.expenses).toBeCloseTo(summary.body.data.totalAmount, 2);
  });

  it("counts a draft sale as neither revenue nor a sale", async () => {
    await testPrisma.invoice.create({
      data: {
        organizationId: tenant.organizationId,
        invoiceNumber: `DRAFT-${RUN_ID}`,
        status: "DRAFT",
        issueDate: new Date(),
        subtotal: 99999,
        taxTotal: 0,
        total: 99999,
        paidAmount: 0,
        dueDate: new Date(),
        currency: "KES",
      },
    });

    const res = await request(testApp).get("/api/v1/reports/dashboard").set(auth(tenant.token));
    // 99999 would be obvious. A draft sale quietly inflating the takings is the failure
    // that gets noticed a month later, when the bank does not agree.
    expect(res.body.data.month.revenue).toBeCloseTo(2000, 2);
    expect(res.body.data.today.revenue).toBeCloseTo(2000, 2);

    await testPrisma.invoice.deleteMany({
      where: { organizationId: tenant.organizationId, invoiceNumber: `DRAFT-${RUN_ID}` },
    });
  });

  it("lists the sale and the product it sold", async () => {
    const res = await request(testApp).get("/api/v1/reports/dashboard").set(auth(tenant.token));
    expect(res.body.data.recentInvoices.length).toBeGreaterThan(0);
    expect(res.body.data.topProducts.length).toBeGreaterThan(0);
    // The product name must be resolved server side. Shipping an id and letting the
    // browser guess is how a table ends up reading "Unknown product" in production.
    expect(res.body.data.topProducts[0].name).toBe("Dashboard Widget");
    expect(res.body.data.topProducts[0].quantity).toBeCloseTo(2, 2);
  });

  it("shows a walk-in sale as one, rather than an empty customer", async () => {
    const res = await request(testApp).get("/api/v1/reports/dashboard").set(auth(tenant.token));
    const sale = res.body.data.recentInvoices.find(
      (i: { id: string }) => i.id === res.body.data.recentInvoices[0].id
    );
    expect(sale).toBeDefined();
    // The sale in this suite was rung up with no customer, and the payload must be honest
    // about that rather than inventing a placeholder name.
    expect(sale.customer === null || sale.customer === undefined).toBe(true);
  });

  it("tells one business nothing about another's figures", async () => {
    const res = await request(testApp)
      .get("/api/v1/reports/dashboard")
      .set(auth(other.token))
      .expect(200);
    // A fresh business trades nothing, and must see nothing. If tenant scoping leaked,
    // it would inherit 2000 and a widget it never sold.
    expect(res.body.data.month.revenue).toBe(0);
    expect(res.body.data.today.revenue).toBe(0);
    expect(res.body.data.recentInvoices).toHaveLength(0);
    expect(res.body.data.topProducts).toHaveLength(0);
  });

  it("is not readable without a token", async () => {
    await request(testApp).get("/api/v1/reports/dashboard").expect(401);
  });
});

describe("the Paystack webhook", () => {
  /**
   * The one endpoint in this system anyone on the internet can post to, and the one that
   * marks invoices paid. It carries no session, so its entire trustworthiness rests on
   * the signature, and it can be tested without a Paystack account: forging a webhook
   * needs no credentials, and refusing one certainly does not.
   */
  const SECRET = "sk_test_integration_webhook_secret";
  const sign = (body: string) => createHmac("sha512", SECRET).update(body).digest("hex");

  const event = JSON.stringify({
    event: "charge.success",
    data: { reference: "INV-NOBODY-abcd1234", amount: 100000, currency: "KES" },
  });

  const original = process.env.PAYSTACK_SECRET_KEY;

  afterAll(() => {
    if (original === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = original;
  });

  it("refuses an unsigned webhook", async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .send(event);
    expect(res.status).toBe(401);
  });

  it("refuses a webhook signed with the wrong key", async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(event).replace(/^./, "0"))
      .send(event);
    // Without this, anyone who learns a reference could post a fake "paid" for it.
    expect(res.status).toBe(401);
  });

  it("refuses a genuine signature over a different body", async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const tampered = event.replace('"amount":100000', '"amount":1');
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(event))
      .send(tampered);
    expect(res.status).toBe(401);
  });

  it("refuses everything when the server has no key at all", async () => {
    // A deployment that has lost its secret must not be able to mark an invoice paid on
    // an unverified claim. This is also the state of every fresh checkout.
    delete process.env.PAYSTACK_SECRET_KEY;
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(event))
      .send(event);
    expect(res.status).toBe(401);
  });

  it("writes nothing when it refuses", async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const before = await testPrisma.cardPayment.count();
    await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .send(event)
      .expect(401);
    const after = await testPrisma.cardPayment.count();
    // A refused webhook that still created a payment row would be worse than useless.
    expect(after).toBe(before);
  });

  it("accepts a correctly signed event for a reference it has never issued", async () => {
    // The signature check passes, so the event is treated as genuine. The reference is
    // then not found, which is the safe outcome: nothing is marked paid, and the caller
    // is told plainly rather than being handed a success it cannot trust.
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(event))
      .send(event);
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it("carries no session requirement, because Paystack sends none", async () => {
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    const res = await request(testApp)
      .post("/api/v1/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(event))
      .send(event);
    // A 401 here would mean the route had been put behind auth and would now reject every
    // real webhook; a 404 proves the signature gate was passed without a token.
    expect(res.status).not.toBe(401);
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
