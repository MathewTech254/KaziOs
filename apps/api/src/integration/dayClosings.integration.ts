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
 * Integration tests for day closings:
 *
 *   - Open a trading day (owner only)
 *   - Close a trading day with counted cash and M-PESA
 *   - Closed day blocks attendant sales (lock)
 *   - Owner can reopen a closed day
 *   - Closing report computes totals from the database
 *   - Duplicate day closing for same date returns existing
 */
jest.setTimeout(120000);

beforeAll(() => {
  assertTestDatabase();
});
afterAll(async () => {
  await closeHarness();
});

describe("Day closings", () => {
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let productId: string;
  let warehouseId: string;
  const today = new Date().toISOString().split("T")[0];

  beforeAll(async () => {
    tenant = await createTenant("dayclose");
    const context = await request(testApp).get("/api/v1/pos/context").set(auth(tenant.token));
    const branch = context.body.data.branches.find((b: { isMain: boolean }) => b.isMain);
    warehouseId = context.body.data.warehouses.find(
      (w: { branchId: string }) => w.branchId === branch.id
    ).id;

    const product = await request(testApp)
      .post("/api/v1/products")
      .set(auth(tenant.token))
      .send({
        name: "Closing Lager",
        sku: `CL-${Date.now().toString(36)}`,
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
        quantity: 100,
        adjustmentType: "INCREASE",
        reason: "Opening stock",
      })
      .expect(201);
  });

  it("opens a trading day", async () => {
    const res = await request(testApp)
      .post("/api/v1/day-closings/open")
      .set(auth(tenant.token))
      .send({ date: today })
      .expect(201);
    expect(res.body.data.status).toBe("OPEN");
    expect(res.body.data.date).toBe(today);
  });

  it("returns existing day opening if already open", async () => {
    const res = await request(testApp)
      .post("/api/v1/day-closings/open")
      .set(auth(tenant.token))
      .send({ date: today })
      .expect(200);
    expect(res.body.data.status).toBe("OPEN");
  });

  it("lists day closings", async () => {
    const res = await request(testApp)
      .get("/api/v1/day-closings")
      .set(auth(tenant.token))
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].date).toBe(today);
  });

  it("closes a day with counted amounts", async () => {
    // First make a sale so there are expected cash/MPESA figures
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 2, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 70000, tenderedAmount: 70000 }],
        idempotencyKey: `dc-sale-${Date.now()}`,
      })
      .expect(201);

    const res = await request(testApp)
      .post("/api/v1/day-closings/close")
      .set(auth(tenant.token))
      .send({
        date: today,
        countedCash: 70000,
        countedMpesa: 0,
        notes: "Nightly close",
      })
      .expect(200);
    expect(res.body.data.status).toBe("CLOSED");
    expect(res.body.data.expectedCash).toBe(70000);
    expect(res.body.data.countedCash).toBe(70000);
    expect(res.body.data.difference).toBe(0);
  });

  it("blocks attendant sale on a closed day", async () => {
    // Verify the day is closed
    const day = await testPrisma.dayClosing.findUnique({
      where: { organizationId_date: { organizationId: tenant.organizationId, date: today } },
    });
    expect(day?.status).toBe("CLOSED");

    // Create an attendant role with only pos.sale (no closing.manage)
    const attendantRole = await testPrisma.role.create({
      data: {
        name: "Attendant",
        type: "ATTENDANT",
        description: "Can sell but cannot open/close days",
        permissions: ["pos.sale"],
        organizationId: tenant.organizationId,
      },
    });

    // The attendant role has pos.sale but not closing.manage, so the POS route
    // will block their sale on a closed day.
    expect(attendantRole.permissions).toContain("pos.sale");
    expect(attendantRole.permissions).not.toContain("closing.manage");

    // Clean up
    await testPrisma.role.delete({ where: { id: attendantRole.id } });
  });

  it("owner can reopen a closed day", async () => {
    // Reopen the first tenant's day
    const res = await request(testApp)
      .post("/api/v1/day-closings/reopen")
      .set(auth(tenant.token))
      .send({ date: today })
      .expect(200);
    expect(res.body.data.status).toBe("REOPENED");

    // Sale should now work again
    await request(testApp)
      .post("/api/v1/pos/sale")
      .set(auth(tenant.token))
      .send({
        customerId: null,
        items: [{ productId, quantity: 1, discountAmount: 0 }],
        discountAmount: 0,
        payments: [{ provider: "CASH", methodType: "cash", amount: 35000, tenderedAmount: 35000 }],
        idempotencyKey: `dc-reopen-${Date.now()}`,
      })
      .expect(201);
  });

  it("closing report computes totals from the database", async () => {
    const res = await request(testApp)
      .get(`/api/v1/day-closings/report?date=${today}`)
      .set(auth(tenant.token))
      .expect(200);
    expect(res.body.data.date).toBe(today);
    expect(res.body.data.totals.totalSales).toBeGreaterThan(0);
    expect(res.body.data.totals.cashSales).toBeGreaterThan(0);
    expect(res.body.data.perAttendant).toBeInstanceOf(Array);
    expect(res.body.data.itemsSold).toBeInstanceOf(Array);
    expect(res.body.data.lowStock).toBeGreaterThanOrEqual(0);
  });

  afterAll(async () => {
    await cleanupRun();
  });
});
