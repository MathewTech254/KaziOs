import { prisma } from "../lib/prisma";
import { periodRange, runTool, TOOL_CATALOG } from "./aiTools";

/**
 * The tools are the part of the assistant that touches money, so they are tested directly
 * against a mocked database rather than through the language model. What is proven here is
 * that every figure the assistant can ever state is derived from the shop's own rows: the
 * sums, the counts, the averages and the filters. If these pass, a wrong number cannot come
 * from the data layer, which is the whole point of routing numbers through tools.
 */

jest.mock("../lib/prisma", () => ({
  prisma: {
    payment: { findMany: jest.fn(), create: jest.fn() },
    invoice: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    invoiceItem: { findMany: jest.fn(), groupBy: jest.fn() },
    product: { findMany: jest.fn() },
    branch: { findMany: jest.fn() },
    expense: { findMany: jest.fn() },
  },
}));

const ORG = "org-1";
const ctx = { organizationId: ORG, currency: "KES" };
const writeCtx = {
  organizationId: ORG,
  currency: "KES",
  permissions: ["invoices.send", "invoices.void", "payments.create"],
};
const noPermCtx = { organizationId: ORG, currency: "KES", permissions: [] };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("periodRange", () => {
  it("gives a single UTC day for today", () => {
    const now = new Date("2026-10-14T15:30:00Z");
    const { from, to } = periodRange("today", now);
    expect(from.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("spans the whole previous month for last_month", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    const { from, to } = periodRange("last_month", now);
    expect(from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("sales_summary", () => {
  it("sums successful payments into cents and computes the average", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { amount: 30, provider: "PAYSTACK" },
      { amount: 20.5, provider: "CASH" },
      { amount: 9.99, provider: "CASH" },
    ]);
    const result = await runTool("sales_summary", ctx, { period: "today" });
    // 30.00 + 20.50 + 9.99 = 60.49 -> 6049 cents; average 2016.33 -> 2016
    expect(result.data.revenueCents).toBe(6049);
    expect(result.data.salesCount).toBe(3);
    expect(result.data.averageCents).toBe(2016);
    expect(result.summary).toContain("KES");
    expect(result.summary).toContain("3 sales");
  });

  it("scopes the query to the organization", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    await runTool("sales_summary", ctx, { period: "today" });
    const where = (prisma.payment.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect(where.status).toBe("SUCCESS");
  });

  it("says so plainly when there were no sales", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("sales_summary", ctx, { period: "today" });
    expect(result.data.revenueCents).toBe(0);
    expect(result.summary).toMatch(/No sales were recorded today/);
  });
});

describe("low_stock", () => {
  it("nets off reserved stock and flags products at or below reorder level", async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([
      { name: "Milk", sku: "MK", reorderPoint: 10, inventories: [{ quantity: 8, reserved: 0 }] },
      { name: "Sugar", sku: "SG", reorderPoint: 5, inventories: [{ quantity: 40, reserved: 0 }] },
      { name: "Flour", sku: "FL", reorderPoint: 20, inventories: [{ quantity: 25, reserved: 10 }] },
    ]);
    const result = await runTool("low_stock", ctx, {});
    const items = result.data.items as { name: string; onHand: number }[];
    // Milk 8<=10 flagged; Sugar 40>5 not; Flour (25-10)=15<=20 flagged.
    expect(items.map(i => i.name)).toEqual(["Milk", "Flour"]);
    expect(items[0].onHand).toBe(8);
  });

  it("reassures when everything is above its reorder level", async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([
      { name: "Sugar", sku: "SG", reorderPoint: 5, inventories: [{ quantity: 40, reserved: 0 }] },
    ]);
    const result = await runTool("low_stock", ctx, {});
    expect(result.data.count).toBe(0);
    expect(result.summary).toMatch(/above its reorder level/);
  });
});

describe("who_owes", () => {
  it("totals only the unpaid balance of each invoice, largest debt first", async () => {
    (prisma.invoice.findMany as jest.Mock).mockResolvedValue([
      {
        invoiceNumber: "INV-1",
        total: 100,
        paidAmount: 40,
        dueDate: null,
        customer: { name: "Asha" },
      },
      {
        invoiceNumber: "INV-2",
        total: 50,
        paidAmount: 50,
        dueDate: null,
        customer: { name: "Ben" },
      },
      { invoiceNumber: "INV-3", total: 75, paidAmount: 0, dueDate: null, customer: null },
    ]);
    const result = await runTool("who_owes", ctx, {});
    // INV-1 owes 60.00, INV-2 owes 0 (excluded), INV-3 owes 75.00 -> 13500 cents
    expect(result.data.totalOwedCents).toBe(13500);
    expect(result.data.count).toBe(2);
    const invoices = result.data.invoices as { customer: string; owedCents: number }[];
    // Sorted by amount owed, descending: the 75.00 walk-in is first, then Asha's 60.00.
    expect(invoices[0].customer).toBe("Walk-in");
    expect(invoices[0].owedCents).toBe(7500);
    expect(invoices[1].customer).toBe("Asha");
    expect(invoices[1].owedCents).toBe(6000);
  });

  it("reports a clean slate when nothing is outstanding", async () => {
    (prisma.invoice.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("who_owes", ctx, {});
    expect(result.data.count).toBe(0);
    expect(result.summary).toMatch(/no outstanding invoices/);
  });
});

describe("routing safety net", () => {
  it("falls back to sales_summary for an unknown tool rather than throwing", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("does_not_exist", ctx, {});
    expect(result.data).toHaveProperty("revenueCents");
  });

  it("exposes a catalogue the model can route against", () => {
    expect(TOOL_CATALOG.map(t => t.name)).toContain("sales_summary");
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(5);
  });
});

describe("cash_position", () => {
  it("sums successful payments in the shop's currency for a period", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { amount: 30, currency: "KES" },
      { amount: 20, currency: "KES" },
      { amount: 100, currency: "USD" },
    ]);
    const result = await runTool("cash_position", ctx, { period: "today" });
    // 30.00 + 20.00 = 50.00 -> 5000 cents; the USD payment is excluded.
    expect(result.data.receivedCents).toBe(5000);
    expect(result.data.paymentCount).toBe(3);
    expect(result.summary).toMatch(/50\.00/);
  });

  it("scopes to organization, status SUCCESS, and the period window", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    await runTool("cash_position", ctx, { period: "today" });
    const where = (prisma.payment.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect(where.status).toBe("SUCCESS");
    expect(where.paidAt).toBeDefined();
  });

  it("reports nothing collected when there were no payments", async () => {
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("cash_position", ctx, { period: "today" });
    expect(result.data.receivedCents).toBe(0);
    expect(result.summary).toMatch(/No money was collected today/);
  });
});

describe("expense_summary", () => {
  it("totals expenses by category for a period", async () => {
    (prisma.expense.findMany as jest.Mock).mockResolvedValue([
      { amount: 40, category: { name: "Rent" } },
      { amount: 15, category: { name: "Rent" } },
      { amount: 10, category: { name: "Transport" } },
    ]);
    const result = await runTool("expense_summary", ctx, { period: "this_month" });
    // 40.00 + 15.00 + 10.00 = 65.00 -> 6500 cents; Rent = 55.00, Transport = 10.00
    expect(result.data.totalCents).toBe(6500);
    expect(result.data.expenseCount).toBe(3);
    expect(result.data.byCategory).toEqual({ Rent: 5500, Transport: 1000 });
    expect(result.summary).toMatch(/65\.00/);
  });

  it("scopes to organization, excludes voided expenses, and filters by period", async () => {
    (prisma.expense.findMany as jest.Mock).mockResolvedValue([]);
    await runTool("expense_summary", ctx, { period: "today" });
    const where = (prisma.expense.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect(where.status).toEqual({ not: "VOIDED" });
    expect(where.expenseDate).toBeDefined();
  });

  it("reports none recorded when there were no expenses", async () => {
    (prisma.expense.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("expense_summary", ctx, { period: "today" });
    expect(result.data.totalCents).toBe(0);
    expect(result.summary).toMatch(/No expenses were recorded today/);
  });
});

describe("branch_stock", () => {
  it("counts tracked products and items below reorder level per branch", async () => {
    (prisma.branch.findMany as jest.Mock).mockResolvedValue([
      {
        name: "Downtown",
        code: "DT",
        warehouses: [
          {
            inventories: [
              { quantity: 5, product: { name: "Milk", reorderPoint: 10, trackStock: true } },
              { quantity: 40, product: { name: "Sugar", reorderPoint: 5, trackStock: true } },
              { quantity: 0, product: { name: "Bread", reorderPoint: 0, trackStock: true } },
            ],
          },
        ],
      },
      { name: "Uptown", code: "UP", warehouses: [{ inventories: [] }] },
    ]);
    const result = await runTool("branch_stock", ctx, {});
    const branches = result.data.branches as { branch: string; lowStockCount: number }[];
    // Milk is low (rp 10 > 0, onHand 5 <= 10); Bread has rp 0 so is not flagged.
    expect(branches[0].branch).toBe("Downtown");
    expect(branches[0].lowStockCount).toBe(1);
    expect(branches[1].branch).toBe("Uptown");
    expect(branches[1].lowStockCount).toBe(0);
    expect(result.summary).toContain("Downtown: 1 low");
  });

  it("reassures when nothing is below its reorder level", async () => {
    (prisma.branch.findMany as jest.Mock).mockResolvedValue([
      {
        name: "Downtown",
        code: "DT",
        warehouses: [
          {
            inventories: [
              { quantity: 40, product: { name: "Sugar", reorderPoint: 5, trackStock: true } },
            ],
          },
        ],
      },
    ]);
    const result = await runTool("branch_stock", ctx, {});
    expect(result.summary).toMatch(/nothing is below its reorder level/);
  });

  it("reports no branches when none are set up", async () => {
    (prisma.branch.findMany as jest.Mock).mockResolvedValue([]);
    const result = await runTool("branch_stock", ctx, {});
    expect(result.summary).toMatch(/No branches are set up yet/);
  });
});

describe("send_invoice", () => {
  const invoice = {
    id: "inv-1",
    invoiceNumber: "INV-001",
    status: "DRAFT",
    total: 50,
    paidAmount: 0,
    customer: { name: "Acme Ltd", phone: "+254700000000" },
  };

  it("previews without sending when confirm is false", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    const result = await runTool("send_invoice", writeCtx, { invoiceId: "inv-1", confirm: false });
    expect(result.summary).toContain("I can send invoice INV-001");
    expect(result.summary).toContain("nothing has been sent yet");
    expect(result.data.wouldSend).toBe(true);
    expect(result.data.confirmRequired).toBe(true);
    expect((prisma.invoice.update as jest.Mock).mock.calls.length).toBe(0);
  });

  it("sends a draft invoice and updates status to SENT", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    (prisma.invoice.update as jest.Mock).mockResolvedValue({ ...invoice, status: "SENT" });
    const result = await runTool("send_invoice", writeCtx, { invoiceId: "inv-1", confirm: true });
    expect(result.summary).toContain("has been sent");
    expect(result.data.status).toBe("SENT");
    const updateCalls = (prisma.invoice.update as jest.Mock).mock.calls;
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toEqual({
      where: { id: "inv-1" },
      data: { status: "SENT" },
    });
  });

  it("refuses to send a non-draft invoice", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({ ...invoice, status: "SENT" });
    await expect(
      runTool("send_invoice", writeCtx, { invoiceId: "inv-1", confirm: true })
    ).rejects.toThrow(/Only draft invoices can be sent/);
  });

  it("returns 404 when the invoice does not exist", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(
      runTool("send_invoice", writeCtx, { invoiceId: "missing", confirm: true })
    ).rejects.toThrow(/Invoice not found/);
  });

  it("rejects when the caller lacks invoices.send permission", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    await expect(
      runTool("send_invoice", noPermCtx, { invoiceId: "inv-1", confirm: true })
    ).rejects.toThrow(/do not have permission to send invoices/);
    expect((prisma.invoice.update as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe("void_invoice", () => {
  const invoice = {
    id: "inv-2",
    invoiceNumber: "INV-002",
    status: "SENT",
    total: 100,
    customer: { name: "Acme Ltd" },
  };

  it("previews voiding without mutating when confirm is false", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    const result = await runTool("void_invoice", writeCtx, { invoiceId: "inv-2", confirm: false });
    expect(result.summary).toContain("I can void invoice INV-002");
    expect(result.data.wouldVoid).toBe(true);
    expect(result.data.confirmRequired).toBe(true);
    expect((prisma.invoice.update as jest.Mock).mock.calls.length).toBe(0);
  });

  it("voids an invoice when confirm is true", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    (prisma.invoice.update as jest.Mock).mockResolvedValue({ ...invoice, status: "VOID" });
    const result = await runTool("void_invoice", writeCtx, { invoiceId: "inv-2", confirm: true });
    expect(result.summary).toContain("has been voided");
    expect(result.data.status).toBe("VOID");
    expect(result.data.voided).toBe(true);
  });

  it("refuses to void an already voided invoice", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({ ...invoice, status: "VOID" });
    await expect(
      runTool("void_invoice", writeCtx, { invoiceId: "inv-2", confirm: true })
    ).rejects.toThrow(/already voided/);
  });

  it("rejects when the caller lacks invoices.void permission", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    await expect(
      runTool("void_invoice", noPermCtx, { invoiceId: "inv-2", confirm: true })
    ).rejects.toThrow(/do not have permission to void invoices/);
    expect((prisma.invoice.update as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe("record_payment", () => {
  const invoice = {
    id: "inv-3",
    invoiceNumber: "INV-003",
    status: "SENT",
    total: 200,
    paidAmount: 50,
    customer: { name: "Acme Ltd" },
  };

  it("previews recording without mutating when confirm is false", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    const result = await runTool("record_payment", writeCtx, {
      invoiceId: "inv-3",
      amountCents: 10000,
      confirm: false,
    });
    expect(result.summary).toContain("I can record a payment of KES\u00A0100.00");
    expect(result.data.wouldRecord).toBe(true);
    expect(result.data.confirmRequired).toBe(true);
    expect((prisma.payment.create as jest.Mock).mock.calls.length).toBe(0);
  });

  it("records a payment and updates the invoice status", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    (prisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-1" });
    (prisma.invoice.update as jest.Mock).mockResolvedValue({
      ...invoice,
      paidAmount: 150,
      status: "PARTIALLY_PAID",
    });
    const result = await runTool("record_payment", writeCtx, {
      invoiceId: "inv-3",
      amountCents: 10000,
      confirm: true,
    });
    expect(result.summary).toContain("Recorded KES\u00A0100.00");
    expect(result.data.amountCents).toBe(10000);
    expect(result.data.status).toBe("PARTIALLY_PAID");
    expect((prisma.payment.create as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    const updateCalls = (prisma.invoice.update as jest.Mock).mock.calls;
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toEqual({
      where: { id: "inv-3" },
      data: { paidAmount: 150, status: "PARTIALLY_PAID" },
    });
  });

  it("rejects a payment that exceeds the outstanding amount", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    await expect(
      runTool("record_payment", writeCtx, {
        invoiceId: "inv-3",
        amountCents: 200000,
        confirm: true,
      })
    ).rejects.toThrow(/exceeds the outstanding/);
    expect((prisma.payment.create as jest.Mock).mock.calls.length).toBe(0);
  });

  it("rejects a zero or negative amount", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    await expect(
      runTool("record_payment", writeCtx, { invoiceId: "inv-3", amountCents: 0, confirm: true })
    ).rejects.toThrow(/greater than zero/);
    expect((prisma.payment.create as jest.Mock).mock.calls.length).toBe(0);
  });

  it("rejects when the caller lacks payments.create permission", async () => {
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice);
    await expect(
      runTool("record_payment", noPermCtx, {
        invoiceId: "inv-3",
        amountCents: 10000,
        confirm: true,
      })
    ).rejects.toThrow(/do not have permission to record payments/);
    expect((prisma.payment.create as jest.Mock).mock.calls.length).toBe(0);
  });
});
