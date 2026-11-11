import request from "supertest";
import { createApp } from "../index";
import { PrismaClient } from "@prisma/client";

/**
 * The API must boot and serve sales, stock, customers, expenses and reports with NO Redis.
 *
 * This test starts the real Express app (createApp) with REDIS_URL unset, so express-session
 * falls back to MemoryStore and realtime stays in-process. It then exercises register, login,
 * a sale, a stock read, a report and logout over real HTTP.
 *
 * It needs DATABASE_URL pointing at a database it may write to (a scratch test database).
 * It refuses to run against a database whose name does not look like a test database.
 */
jest.setTimeout(120000);

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL || "";
  let name = "";
  try {
    name = new URL(url).pathname.replace(/^\//, "");
  } catch {
    /* handled by the empty check below */
  }
  if (!name) throw new Error("DATABASE_URL is not set; integration tests cannot run");
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": it does not look like a ` +
        `test database. Point DATABASE_URL at a scratch database.`
    );
  }
}

const prisma = new PrismaClient();
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  assertTestDatabase();
  // REDIS_URL must be absent for this suite. Unset it so createApp uses MemoryStore.
  delete process.env.REDIS_URL;
  app = createApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("API without Redis", () => {
  let token: string;
  let organizationId: string;
  let productId: string;
  let warehouseId: string;

  it("boots and answers health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("registers a business", async () => {
    const email = `redisfree-${Date.now()}@example.test`;
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Redis Free Shop",
        name: "Owner",
        email,
        password: "KaziOS!Integration2026",
        country: "KE",
        currency: "KES",
        timezone: "Africa/Nairobi",
      });
    expect(res.status).toBe(201);
    token = res.body.data.token;
    organizationId = res.body.data.organization.id;
    expect(token).toBeTruthy();
    expect(organizationId).toBeTruthy();
  });

  it("logs in", async () => {
    // Find the user we just registered
    const user = await prisma.user.findFirst({
      where: { organizationId },
      select: { email: true },
    });
    expect(user).toBeTruthy();

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user!.email, password: "KaziOS!Integration2026" });
    expect(res.status).toBe(200);
    token = res.body.data.token;
    expect(token).toBeTruthy();
  });

  it("creates a product and receives stock", async () => {
    // Get the main warehouse from POS context
    const context = await request(app)
      .get("/api/v1/pos/context")
      .set("Authorization", `Bearer ${token}`);
    expect(context.status).toBe(200);
    const branch = context.body.data.branches.find((b: { isMain: boolean }) => b.isMain);
    warehouseId = context.body.data.warehouses.find(
      (w: { branchId: string }) => w.branchId === branch.id
    ).id;

    const product = await request(app)
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Tusker Lager",
        sku: `RF-${Date.now().toString(36)}`,
        costPrice: 20000,
        sellingPrice: 35000,
        minStock: 5,
        trackStock: true,
        unitId: null,
      });
    expect(product.status).toBe(201);
    productId = product.body.data.id;

    const received = await request(app)
      .post("/api/v1/inventory/adjustments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId,
        warehouseId,
        quantity: 24,
        adjustmentType: "INCREASE",
        reason: "Opening stock",
      });
    expect(received.status).toBe(201);
  });

  it("reads stock levels", async () => {
    const res = await request(app)
      .get("/api/v1/inventory/")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const row = res.body.data.find((r: { productId: string }) => r.productId === productId);
    expect(row).toBeDefined();
    expect(row?.quantity).toBeGreaterThanOrEqual(24);
  });

  it("makes a cash sale that decrements stock", async () => {
    const res = await request(app)
      .post("/api/v1/pos/sale")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: null,
        items: [{ productId, quantity: 3, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 105000, tenderedAmount: 105000 }],
        idempotencyKey: `redisfree-sale-${Date.now()}`,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.total).toBe(105000);

    // Stock: 24 received, 3 sold, 21 left.
    const inventory = await prisma.inventory.findFirst({
      where: { productId, warehouseId },
    });
    expect(inventory?.quantity).toBe(21);
  });

  it("reads the dashboard report", async () => {
    const res = await request(app)
      .get("/api/v1/reports/dashboard")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.month.revenue).toBeGreaterThan(0);
  });

  it("reads customers", async () => {
    const res = await request(app)
      .get("/api/v1/customers")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("reads expenses", async () => {
    const res = await request(app)
      .get("/api/v1/expenses")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("logs out and the session is revoked", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.success).toBe(true);

    // The revoked token must no longer work.
    await request(app)
      .get("/api/v1/customers")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  afterAll(async () => {
    // Remove only the organization this test created.
    if (organizationId) {
      await prisma.$transaction(async tx => {
        await tx.journalLine.deleteMany({ where: { journalEntry: { organizationId } } });
        await tx.journalEntry.deleteMany({ where: { organizationId } });
        await tx.invoiceItem.deleteMany({ where: { invoice: { organizationId } } });
        await tx.cardPayment.deleteMany({ where: { organizationId } });
        await tx.payment.deleteMany({ where: { organizationId } });
        await tx.paymentWebhookEvent.deleteMany({ where: { organizationId } });
        await tx.invoice.deleteMany({ where: { organizationId } });
        await tx.stockMovement.deleteMany({ where: { organizationId } });
        await tx.inventory.deleteMany({ where: { organizationId } });
        await tx.expense.deleteMany({ where: { organizationId } });
        await tx.customer.deleteMany({ where: { organizationId } });
        await tx.product.deleteMany({ where: { organizationId } });
        await tx.taxCategory.deleteMany({ where: { organizationId } });
        await tx.account.deleteMany({ where: { organizationId } });
        await tx.warehouse.deleteMany({ where: { organizationId } });
        await tx.branch.deleteMany({ where: { organizationId } });
        await tx.setting.deleteMany({ where: { organizationId } });
        await tx.auditLog.deleteMany({ where: { organizationId } });
        await tx.notification.deleteMany({ where: { organizationId } });
        await tx.session.deleteMany({ where: { user: { organizationId } } });
        await tx.userRole.deleteMany({ where: { user: { organizationId } } });
        await tx.role.deleteMany({ where: { organizationId } });
        await tx.user.deleteMany({ where: { organizationId } });
        await tx.organization.delete({ where: { id: organizationId } });
      });
    }
  });
});
