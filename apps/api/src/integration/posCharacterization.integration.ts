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

  it("restores stock via RETURN movement on full return", async () => {
    // Make a sale of 2 units
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 2, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 70000, tenderedAmount: 70000 }],
        idempotencyKey: `char-return-${Date.now()}`,
      }))
      .expect(201);
    const invoiceId = sale.body.data.invoice.id;

    const beforeReturn = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });

    const returned = await request(testApp)
      .post(`/api/v1/pos/sales/${invoiceId}/return`)
      .set(auth(tenant.token))
      .send({ warehouseId })
      .expect(200);

    expect(returned.body.data.status).toBe("VOID");
    expect(returned.body.data.paidAmount).toBe(0);

    // Stock restored
    const afterReturn = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(afterReturn?.quantity).toBe(beforeReturn?.quantity! + 2);

    // RETURN movement exists
    const movements = await testPrisma.stockMovement.findMany({
      where: { organizationId: tenant.organizationId, type: "RETURN" },
    });
    expect(movements.length).toBeGreaterThanOrEqual(1);
    const returnMovement = movements.find(m => m.reference === sale.body.data.invoice.invoiceNumber);
    expect(returnMovement).toBeTruthy();
    expect(returnMovement!.quantity).toBe(2);

    // Payments refunded
    const payments = await testPrisma.payment.findMany({ where: { invoiceId } });
    expect(payments.every(p => p.status === "REFUNDED")).toBe(true);
  });

  it("rejects a second return of the same invoice with 409", async () => {
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `char-dblreturn-${Date.now()}`,
      }))
      .expect(201);
    const invoiceId = sale.body.data.invoice.id;

    // First return succeeds
    await request(testApp)
      .post(`/api/v1/pos/sales/${invoiceId}/return`)
      .set(auth(tenant.token))
      .send({ warehouseId })
      .expect(200);

    // Second return is rejected
    const second = await request(testApp)
      .post(`/api/v1/pos/sales/${invoiceId}/return`)
      .set(auth(tenant.token))
      .send({ warehouseId });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already|cancelled|returned/i);

    // Stock was restored only once (no over-refund)
    const movements = await testPrisma.stockMovement.findMany({
      where: {
        organizationId: tenant.organizationId,
        type: "RETURN",
        reference: sale.body.data.invoice.invoiceNumber,
      },
    });
    expect(movements).toHaveLength(1);
  });

  it("concurrency: two simultaneous sales of the last unit - exactly one succeeds", async () => {
    // Set up a product with exactly 1 unit
    const concurrencyProduct = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Concurrency Bottle",
        sku: `CONC-${Date.now().toString(36)}`,
        costPrice: 10000,
        sellingPrice: 25000,
        minStock: 0,
        trackStock: true,
        unitId: null,
      });
    expect(concurrencyProduct.status).toBe(201);
    const concurrencyProductId = concurrencyProduct.body.data.id;

    await request(testApp)
      .post("/api/v1/inventory/adjustments")
      .set(auth(tenant.token))
      .send({
        productId: concurrencyProductId,
        warehouseId,
        quantity: 1,
        adjustmentType: "INCREASE",
        reason: "Single unit",
      })
      .expect(201);

    const basePayload = {
      customerId: null,
      items: [{ productId: concurrencyProductId, quantity: 1, discountAmount: 0 }],
      discountAmount: 0,
      payments: [{ provider: "CASH", methodType: "cash", amount: 25000, tenderedAmount: 25000 }],
    };

    // Fire two simultaneous sales
    const [first, second] = await Promise.all([
      request(testApp)
        .post("/api/v1/pos/sale")
        .set(auth(tenant.token))
        .send({ ...basePayload, idempotencyKey: `conc-1-${Date.now()}` }),
      request(testApp)
        .post("/api/v1/pos/sale")
        .set(auth(tenant.token))
        .send({ ...basePayload, idempotencyKey: `conc-2-${Date.now()}` }),
    ]);

    const statuses = [first.status, second.status].sort();
    // Exactly one succeeds (201). The other must be refused — today it can be 409
    // (clean stock conflict) or 500 (Prisma serialization abort under concurrent
    // Serializable transactions). Both prevent overselling; the 500 case is a bug
    // tracked in Findings.
    expect(statuses[0]).toBe(201);
    expect([409, 500]).toContain(statuses[1]);

    // Stock never goes negative
    const inventory = await testPrisma.inventory.findFirst({
      where: { productId: concurrencyProductId, warehouseId },
    });
    expect(inventory?.quantity).toBe(0);
    expect(inventory?.quantity).toBeGreaterThanOrEqual(0);
  });

  it("ledger consistency: inventory decreases by exactly sold quantity", async () => {
    const before = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    const beforeQty = before?.quantity ?? 0;

    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 4, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 140000, tenderedAmount: 140000 }],
        idempotencyKey: `char-ledger-${Date.now()}`,
      }))
      .expect(201);

    const after = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(after?.quantity).toBe(beforeQty - 4);

    // Exactly one SALE movement for this sale
    const movements = await testPrisma.stockMovement.findMany({
      where: {
        organizationId: tenant.organizationId,
        type: "SALE",
        productId,
        reference: sale.body.data.invoice.invoiceNumber,
      },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].quantity).toBe(-4);
    expect(movements[0].warehouseId).toBe(warehouseId);
  });

  it("rounding: discount allocated across multiple lines", async () => {
    // Two products at 33333 each, order discount 10000
    const p1 = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Rounding Product A",
        sku: `RND-A-${Date.now().toString(36)}`,
        costPrice: 10000,
        sellingPrice: 33333,
        minStock: 0,
        trackStock: true,
        unitId: null,
      });
    expect(p1.status).toBe(201);

    const p2 = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Rounding Product B",
        sku: `RND-B-${Date.now().toString(36)}`,
        costPrice: 10000,
        sellingPrice: 33333,
        minStock: 0,
        trackStock: true,
        unitId: null,
      });
    expect(p2.status).toBe(201);

    await request(testApp)
      .post("/api/v1/inventory/adjustments")
      .set(auth(tenant.token))
      .send({ productId: p1.body.data.id, warehouseId, quantity: 10, adjustmentType: "INCREASE", reason: "stock" })
      .expect(201);
    await request(testApp)
      .post("/api/v1/inventory/adjustments")
      .set(auth(tenant.token))
      .send({ productId: p2.body.data.id, warehouseId, quantity: 10, adjustmentType: "INCREASE", reason: "stock" })
      .expect(201);

    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [
          { productId: p1.body.data.id, quantity: 1, discountAmount: 0 },
          { productId: p2.body.data.id, quantity: 1, discountAmount: 0 },
        ],
        discountAmount: 10000,
        payments: [{ provider: "CASH", methodType: "cash", amount: 56666, tenderedAmount: 56666 }],
        idempotencyKey: `char-round-${Date.now()}`,
      }))
      .expect(201);

    // Total = 33333 + 33333 - 10000 = 56666
    expect(sale.body.data.invoice.total).toBe(56666);
    expect(sale.body.data.invoice.paidAmount).toBe(56666);

    // Line totals must sum to the invoice total
    const items = await testPrisma.invoiceItem.findMany({
      where: { invoiceId: sale.body.data.invoice.id },
    });
    const lineSum = items.reduce((sum, i) => sum + Number(i.lineTotal), 0);
    expect(lineSum).toBe(56666);
  });

  it("MPESA_MANUAL: requires transaction code, rejects without it", async () => {
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "MPESA_MANUAL", methodType: "manual", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `char-mpesa-no-code-${Date.now()}`,
      }))
      .expect(400);
  });

  it("MPESA_MANUAL: accepts sale with valid transaction code", async () => {
    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "MPESA_MANUAL", methodType: "manual", amount: 35000, tenderedAmount: 35000, transactionCode: "MPESA123456" }],
        idempotencyKey: `char-mpesa-ok-${Date.now()}`,
      }))
      .expect(201);

    expect(sale.body.data.invoice.total).toBe(35000);
    expect(sale.body.data.invoice.paidAmount).toBe(35000);

    // providerRef stores the transaction code
    const payment = await testPrisma.payment.findFirst({
      where: { invoiceId: sale.body.data.invoice.id },
    });
    expect(payment?.providerRef).toBe("MPESA123456");
  });

  it("MPESA_MANUAL: rejects duplicate transaction code within organization", async () => {
    // First sale with the code
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "MPESA_MANUAL", methodType: "manual", amount: 35000, tenderedAmount: 35000, transactionCode: "DUP-CODE-001" }],
        idempotencyKey: `char-mpesa-dup-1-${Date.now()}`,
      }))
      .expect(201);

    // Second sale with the same code should be rejected
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "MPESA_MANUAL", methodType: "manual", amount: 35000, tenderedAmount: 35000, transactionCode: "DUP-CODE-001" }],
        idempotencyKey: `char-mpesa-dup-2-${Date.now()}`,
      }))
      .expect(409);
  });

  it("CREDIT: requires a customer", async () => {
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        customerId: null,
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CREDIT", methodType: "credit", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `char-credit-no-customer-${Date.now()}`,
      }))
      .expect(400);
  });

  it("CREDIT: sale with customer, invoice stays unpaid for credit portion", async () => {
    // Create a customer
    const customer = await request(testApp)
      .post("/api/v1/customers")
      .set(auth(tenant.token))
      .send({
        name: "Credit Customer",
        phone: "+254700000001",
        customerType: "INDIVIDUAL",
      })
      .expect(201);
    const customerId = customer.body.data.id;

    const sale = await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        customerId,
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CREDIT", methodType: "credit", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `char-credit-sale-${Date.now()}`,
      }))
      .expect(201);

    expect(sale.body.data.invoice.total).toBe(35000);
    // Credit portion is unpaid: paidAmount is 0 (no settled payments)
    expect(sale.body.data.invoice.paidAmount).toBe(0);
    expect(sale.body.data.invoice.status).toBe("SENT");

    // Customer owes the full amount
    const invoice = await testPrisma.invoice.findUnique({
      where: { id: sale.body.data.invoice.id },
    });
    expect(invoice?.customerId).toBe(customerId);
    expect(Number(invoice?.total ?? 0) - Number(invoice?.paidAmount ?? 0)).toBe(35000);
  });

  it("CREDIT: enforces credit limit", async () => {
    // Create a customer with a low credit limit
    const customer = await request(testApp)
      .post("/api/v1/customers")
      .set(auth(tenant.token))
      .send({
        name: "Limited Customer",
        phone: "+254700000002",
        customerType: "INDIVIDUAL",
      })
      .expect(201);
    const customerId = customer.body.data.id;

    await testPrisma.customer.update({
      where: { id: customerId },
      data: { creditLimit: 10000 }, // KES 100 limit
    });

    // Sale of 35000 exceeds the 10000 limit
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        customerId,
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        payments: [{ provider: "CREDIT", methodType: "credit", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `char-credit-limit-${Date.now()}`,
      }))
      .expect(409);

    // No invoice was written
    const count = await testPrisma.invoice.count({
      where: { organizationId: tenant.organizationId, customerId },
    });
    expect(count).toBe(0);
  });

  it("allowNegativeStock: default false blocks selling more than available", async () => {
    // Product has 50 units, already sold some. Try to sell 999.
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 999, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 34965000, tenderedAmount: 34965000 }],
        idempotencyKey: `char-neg-stock-${Date.now()}`,
      }))
      .expect(409);
  });

  it("allowNegativeStock: when enabled, allows selling more than available", async () => {
    // Enable allowNegativeStock for this organization
    await testPrisma.setting.upsert({
      where: { organizationId_key: { organizationId: tenant.organizationId, key: "pos" } },
      update: { value: { allowNegativeStock: true } },
      create: { organizationId: tenant.organizationId, key: "pos", value: { allowNegativeStock: true } },
    });

    // Sell 999 units - should succeed since negative stock is allowed
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send(payloadOverrides({
        items: [{ productId, quantity: 999, discountAmount: 0 }],
        payments: [{ provider: "CASH", methodType: "cash", amount: 34965000, tenderedAmount: 34965000 }],
        idempotencyKey: `char-neg-stock-ok-${Date.now()}`,
      }))
      .expect(201);

    // Stock goes negative
    const inventory = await testPrisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(inventory?.quantity).toBeLessThan(0);
  });

  afterAll(async () => {
    await cleanupRun();
  });
});

