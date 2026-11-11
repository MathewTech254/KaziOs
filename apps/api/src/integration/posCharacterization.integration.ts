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
 * Characterization tests for /api/v1/pos/sale.
 *
 * These lock in the CURRENT behavior of the POS sale endpoint before any refactoring:
 *
 *   - Atomicity: sale + items + payments + stock movements + journal entry are written
 *     in one Prisma transaction; an insufficient-stock refusal writes nothing.
 *   - Stock blocking: selling more than available returns 409 and leaves inventory at
 *     its pre-sale value.
 *   - Money: totals are computed in integer minor units from Float shelf prices;
 *     change and paidAmount match to the cent.
 *   - Tenant isolation: one tenant cannot read or write another tenant's sales.
 *   - Permissions: a role without pos.sale cannot call /pos/sale.
 *
 * These are characterization tests: they describe what the code does today. If a later
 * phase changes behavior, these tests are the regression net and must be updated
 * deliberately.
 */
jest.setTimeout(120000);

beforeAll(() => {
  assertTestDatabase();
});
afterAll(async () => {
  await closeHarness();
});

function payloadOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    customerId: null,
    items: [],
    discountAmount: 0,
    payments: [
      { provider: "CASH", methodType: "cash", amount: 0, tenderedAmount: 0 },
    ],
    idempotencyKey: `char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

describe("/pos/sale characterization", () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let productId: string;
  let warehouseId: string;

  beforeAll(async () => {
    tenant = await createTenant("poschar");
    const context = await request(testApp)
      .get("/api/v1/pos/context")
      .set(auth(tenant.token));
    const branch = context.body.data.branches.find((b: { isMain: boolean }) => b.isMain);
    warehouseId = context.body.data.warehouses.find(
      (w: { branchId: string }) => w.branchId === branch.id
    ).id;

    const product = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Characterization Lager",
        sku: `CHAR-${Date.now().toString(36)}`,
        costPrice: 20000,
        sellingPrice: 35000,
        minStock: 5,
        trackStock: true,
        unitId: null,
      });
    expect(product.status).toBe(201);
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
  });

  it("writes sale, items, payments, movements and journal atomically on success", async () => {
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 3, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 105000, tenderedAmount: 105000 }],
      }))
      .expect(201);

    const invoiceId = sale.body.data.invoice.id;

    // Invoice exists
    const invoice = await testPrisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(invoice).toBeTruthy();
    expect(invoice!.total).toBe(105000);
    expect(invoice!.status).toBe("PAID");
    expect(invoice!.paidAmount).toBe(105000);

    // Invoice items exist
    const items = await testPrisma.invoiceItem.findMany({ where: { invoiceId } });
    expect(items).toHaveLength(1);
    expect(items[0].lineTotal).toBe(105000);

    // Payments exist
    const payments = await testPrisma.payment.findMany({ where: { invoiceId } });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(105000);
    expect(payments[0].status).toBe("SUCCESS");

    // Stock movement exists (type SALE, negative quantity)
    const movements = await testPrisma.stockMovement.findMany({
      where: { organizationId: tenant.organizationId, type: "SALE" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-3);

    // Inventory decremented (50 -> 47)
    const inventory = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(inventory?.quantity).toBe(47);

    // Journal entry exists (double-entry: cash + revenue)
    const journals = await testPrisma.journalEntry.findMany({
      where: { organizationId: tenant.organizationId, reference: { startsWith: "JE-" } },
    });
    expect(journals.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses insufficient stock with 409 and writes nothing", async () => {
    const beforeCount = await testPrisma.invoice.count({
      where: { organizationId: tenant.organizationId },
    });

    const res = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 999, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 34965000, tenderedAmount: 34965000 }],
      }))
      .expect(409);

    expect(res.body.error).toContain("only");

    // No invoice written
    const afterCount = await testPrisma.invoice.count({
      where: { organizationId: tenant.organizationId },
    });
    expect(afterCount).toBe(beforeCount);

    // No stock movement written for this product
    const movements = await testPrisma.stockMovement.count({
      where: { organizationId: tenant.organizationId, type: "SALE", productId },
    });
    expect(movements).toBe(1); // Only the first test's successful sale

    // Inventory untouched (still 47 after the first sale)
    const inventory = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(inventory?.quantity).toBe(47);
  });

  it("computes totals in minor units from Float shelf prices", async () => {
    // Shelf price 35000.00, quantity 2 -> total 70000.00 (no fractional cents)
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 2, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 70000, tenderedAmount: 70000 }],
      }))
      .expect(201);

    expect(sale.body.data.invoice.total).toBe(70000);
    expect(sale.body.data.invoice.paidAmount).toBe(70000);
    expect(sale.body.data.changeAmount).toBe(0);

    // Inventory: 47 - 2 = 45
    const inventory = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(inventory?.quantity).toBe(45);
  });

  it("computes change when tendered exceeds total", async () => {
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 35000, tenderedAmount: 50000 }],
      }))
      .expect(201);

    expect(sale.body.data.invoice.total).toBe(35000);
    expect(sale.body.data.changeAmount).toBe(15000);
  });

  it("rejects payment that does not match the total", async () => {
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 1000, tenderedAmount: 1000 }],
      }))
      .expect(400);
  });

  it("enforces tenant isolation: another tenant cannot read this sale", async () => {
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 35000, tenderedAmount: 35000 }],
      }))
      .expect(201);
    const invoiceId = sale.body.data.invoice.id;

    const other = await createTenant("poschar-other");

    const res = await request(testApp)
      .get(`/api/v1/pos/receipt/${invoiceId}`)
      .set(auth(other.token));
    expect(res.status).toBe(404);
  });

  it("enforces tenant isolation: another tenant's POS context has no access to this product", async () => {
    const other = await createTenant("poschar-other2");

    const res = await request(testApp)
      .get("/api/v1/pos/products")
      .set(auth(other.token))
      .query({ search: "Characterization Lager" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("refuses pos.sale when the role lacks the permission", async () => {
    const limited = await createTenant("poschar-limited");
    const role = await testPrisma.role.findFirst({
      where: { organizationId: limited.organizationId, type: "OWNER" },
    });
    await testPrisma.role.update({
      where: { id: role!.id },
      data: { permissions: ["customers.view"] },
    });

    const login = await request(testApp)
      .post("/api/v1/auth/login")
      .send({ email: limited.email, password: "KaziOS!Integration2026" });
    const cashierToken = login.body.data.token;

    // /pos/context requires pos.sale
    await request(testApp)
      .get("/api/v1/pos/context")
      .set(auth(cashierToken))
      .expect(403);

    // /pos/sale requires pos.sale
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(cashierToken))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 35000, tenderedAmount: 35000 }],
      }))
      .expect(403);

    // Nothing was written
    const count = await testPrisma.invoice.count({
      where: { organizationId: limited.organizationId },
    });
    expect(count).toBe(0);
  });

  afterAll(async () => {
    await cleanupRun();
  });
});
