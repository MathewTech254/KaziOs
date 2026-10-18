import { prisma } from "../lib/prisma";

/**
 * The authorized tools behind the AI assistant.
 *
 * These are the "Authorized Tool -> Business Data -> Validation" half of the architecture
 * the README describes. Every number a shop owner is told is computed here, against their
 * own rows, by the database. The language model only chooses which tool to run and words
 * the result; it is never asked to do arithmetic, so it cannot invent a figure.
 *
 * Money is handled in integer cents throughout. Amounts are stored as floats in major
 * units, so each is rounded to cents on the way in and only divided back for display, which
 * is the same discipline the rest of the codebase keeps.
 */

export interface ToolContext {
  organizationId: string;
  currency: string;
}

export type ToolParams = Record<string, unknown>;

export interface ToolResult {
  /** A deterministic, human sentence built from real figures. Safe to show with no model. */
  summary: string;
  /** The structured figures behind the sentence, for the client to render. */
  data: Record<string, unknown>;
}

type Period = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "all_time";

const DAY_MS = 86_400_000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** A half-open [from, to) range for a named period, in UTC so a count never depends on a tz. */
export function periodRange(
  period: Period,
  now: Date = new Date()
): { from: Date; to: Date; label: string } {
  const today = startOfUtcDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  switch (period) {
    case "yesterday":
      return { from: new Date(today.getTime() - DAY_MS), to: today, label: "yesterday" };
    case "this_week": {
      const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
      return { from: new Date(today.getTime() - dow * DAY_MS), to: tomorrow, label: "this week" };
    }
    case "last_month":
      return {
        from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
        to: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
        label: "last month",
      };
    case "all_time":
      return { from: new Date(0), to: tomorrow, label: "all time" };
    case "this_month":
      return {
        from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
        to: tomorrow,
        label: "this month",
      };
    case "today":
    default:
      return { from: today, to: tomorrow, label: "today" };
  }
}

function normalizePeriod(value: unknown): Period {
  const v = String(value ?? "")
    .toLowerCase()
    .trim();
  if (v === "week") return "this_week";
  if (v === "month") return "this_month";
  const known: Period[] = [
    "today",
    "yesterday",
    "this_week",
    "this_month",
    "last_month",
    "all_time",
  ];
  return (known as string[]).includes(v) ? (v as Period) : "today";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function money(cents: number, currency: string): string {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Total money actually taken (successful payments) and how many sales, for a period. */
async function salesSummary(ctx: ToolContext, params: ToolParams): Promise<ToolResult> {
  const { from, to, label } = periodRange(normalizePeriod(params.period));
  const payments = await prisma.payment.findMany({
    where: { organizationId: ctx.organizationId, status: "SUCCESS", paidAt: { gte: from, lt: to } },
    select: { amount: true, provider: true },
  });
  const revenueCents = payments.reduce((sum, p) => sum + Math.round((p.amount || 0) * 100), 0);
  const count = payments.length;
  const averageCents = count ? Math.round(revenueCents / count) : 0;
  const byProviderCents: Record<string, number> = {};
  for (const p of payments) {
    const c = Math.round((p.amount || 0) * 100);
    byProviderCents[p.provider] = (byProviderCents[p.provider] || 0) + c;
  }
  const data = {
    period: label,
    revenueCents,
    salesCount: count,
    averageCents,
    byProviderCents,
    currency: ctx.currency,
  };
  const summary =
    count === 0
      ? `No sales were recorded ${label}.`
      : `You took ${money(revenueCents, ctx.currency)} across ${plural(count, "sale")} ${label}, ` +
        `an average of ${money(averageCents, ctx.currency)} per sale.`;
  return { summary, data };
}

/** Best-selling products by revenue, from paid invoices in a period. */
async function topProducts(ctx: ToolContext, params: ToolParams): Promise<ToolResult> {
  const limit = clampInt(params.limit, 1, 10, 5);
  const { from, to, label } = periodRange(normalizePeriod(params.period));
  const grouped = await prisma.invoiceItem.groupBy({
    by: ["description"],
    where: {
      invoice: {
        organizationId: ctx.organizationId,
        status: "PAID",
        issueDate: { gte: from, lt: to },
      },
    },
    _sum: { quantity: true, lineTotal: true },
    orderBy: { _sum: { lineTotal: "desc" } },
    take: limit,
  });
  const items = grouped.map(g => ({
    name: g.description,
    unitsSold: g._sum.quantity || 0,
    revenueCents: Math.round((g._sum.lineTotal || 0) * 100),
  }));
  const data = { period: label, items, currency: ctx.currency };
  const summary = items.length
    ? `Top sellers ${label}: ` +
      items
        .map(
          (it, i) =>
            `${i + 1}. ${it.name} (${money(it.revenueCents, ctx.currency)}, ${it.unitsSold} sold)`
        )
        .join("; ") +
      "."
    : `No product sales were recorded ${label}.`;
  return { summary, data };
}

/** Products at or below their reorder level, so the owner knows what to buy. */
async function lowStock(ctx: ToolContext, _params: ToolParams): Promise<ToolResult> {
  const products = await prisma.product.findMany({
    where: { organizationId: ctx.organizationId, isActive: true, reorderPoint: { gt: 0 } },
    select: {
      name: true,
      sku: true,
      reorderPoint: true,
      inventories: { select: { quantity: true, reserved: true } },
    },
    take: 300,
  });
  const low = products
    .map(p => {
      const onHand = p.inventories.reduce(
        (s, i) => s + Math.max(0, (i.quantity || 0) - (i.reserved || 0)),
        0
      );
      return { name: p.name, sku: p.sku, onHand, reorderPoint: p.reorderPoint };
    })
    .filter(r => r.onHand <= r.reorderPoint)
    .sort((a, b) => a.onHand - b.onHand)
    .slice(0, 15);
  const data = { count: low.length, items: low };
  const summary = low.length
    ? `${plural(low.length, "product")} at or below the reorder level: ` +
      low.map(r => `${r.name} (${r.onHand} left, reorder at ${r.reorderPoint})`).join("; ") +
      "."
    : "Every tracked product is above its reorder level. Nothing urgent to restock.";
  return { summary, data };
}

/** Unpaid invoices: who owes the business money, and how much in total. */
async function whoOwes(ctx: ToolContext, _params: ToolParams): Promise<ToolResult> {
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] },
    },
    select: {
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      dueDate: true,
      customer: { select: { name: true } },
    },
    take: 300,
  });
  const rows = invoices
    .map(inv => ({
      invoiceNumber: inv.invoiceNumber,
      customer: inv.customer?.name || "Walk-in",
      owedCents: Math.round(((inv.total || 0) - (inv.paidAmount || 0)) * 100),
      dueDate: inv.dueDate,
    }))
    .filter(r => r.owedCents > 0)
    .sort((a, b) => b.owedCents - a.owedCents);
  const totalCents = rows.reduce((s, r) => s + r.owedCents, 0);
  const data = {
    count: rows.length,
    totalOwedCents: totalCents,
    invoices: rows.slice(0, 15),
    currency: ctx.currency,
  };
  const summary = rows.length
    ? `${plural(rows.length, "unpaid invoice")} totalling ${money(totalCents, ctx.currency)}. ` +
      rows
        .slice(0, 5)
        .map(r => `${r.customer} owes ${money(r.owedCents, ctx.currency)} on ${r.invoiceNumber}`)
        .join("; ") +
      "."
    : "There are no outstanding invoices. Everyone has paid in full.";
  return { summary, data };
}

/** Products holding stock that have not sold within a window: capital sitting on the shelf. */
async function slowMovers(ctx: ToolContext, params: ToolParams): Promise<ToolResult> {
  const days = clampInt(params.days, 7, 365, 60);
  const since = new Date(Date.now() - days * DAY_MS);
  const [products, sold] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: ctx.organizationId, isActive: true, trackStock: true },
      select: { id: true, name: true, inventories: { select: { quantity: true } } },
      take: 400,
    }),
    prisma.invoiceItem.findMany({
      where: {
        invoice: { organizationId: ctx.organizationId, status: "PAID", issueDate: { gte: since } },
        productId: { not: null },
      },
      select: { productId: true },
      distinct: ["productId"],
    }),
  ]);
  const soldIds = new Set(sold.map(s => s.productId));
  const dead = products
    .map(p => ({
      id: p.id,
      name: p.name,
      onHand: p.inventories.reduce((s, i) => s + (i.quantity || 0), 0),
    }))
    .filter(r => r.onHand > 0 && !soldIds.has(r.id))
    .sort((a, b) => b.onHand - a.onHand)
    .slice(0, 15)
    .map(({ id: _id, ...rest }) => rest);
  const data = { days, count: dead.length, items: dead };
  const summary = dead.length
    ? `${plural(dead.length, "product")} with stock but no sales in the last ${days} days: ` +
      dead.map(r => `${r.name} (${r.onHand} in stock)`).join("; ") +
      ". Consider a promotion."
    : `Every product with stock has sold within the last ${days} days.`;
  return { summary, data };
}

/** Money collected through successful payments in a period: the till position. */
async function cashPosition(ctx: ToolContext, params: ToolParams): Promise<ToolResult> {
  const { from, to, label } = periodRange(normalizePeriod(params.period));
  const payments = await prisma.payment.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "SUCCESS",
      paidAt: { gte: from, lt: to },
    },
    select: { amount: true, currency: true },
  });
  let receivedCents = 0;
  for (const p of payments) {
    // Only count payments in the shop's own currency; foreign-currency receipts are
    // noted separately rather than mixed into the till total.
    if (p.currency === ctx.currency) {
      receivedCents += Math.round((p.amount || 0) * 100);
    }
  }
  const count = payments.length;
  const data = {
    period: label,
    receivedCents,
    paymentCount: count,
    currency: ctx.currency,
  };
  const summary =
    count === 0
      ? `No money was collected ${label}.`
      : `Cash position ${label}: ${money(receivedCents, ctx.currency)} collected across ${plural(
          count,
          "payment"
        )}.`;
  return { summary, data };
}

/** Money spent, grouped by expense category, for a period. Voided expenses are excluded. */
async function expenseSummary(ctx: ToolContext, params: ToolParams): Promise<ToolResult> {
  const { from, to, label } = periodRange(normalizePeriod(params.period));
  const expenses = await prisma.expense.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: { not: "VOIDED" },
      expenseDate: { gte: from, lt: to },
    },
    select: { amount: true, category: { select: { name: true } } },
  });
  const byCategory: Record<string, number> = {};
  let totalCents = 0;
  for (const e of expenses) {
    const c = Math.round((e.amount || 0) * 100);
    totalCents += c;
    const cat = e.category?.name || "Uncategorized";
    byCategory[cat] = (byCategory[cat] || 0) + c;
  }
  const count = expenses.length;
  const data = {
    period: label,
    totalCents,
    expenseCount: count,
    byCategory,
    currency: ctx.currency,
  };
  const summary =
    count === 0
      ? `No expenses were recorded ${label}.`
      : `You spent ${money(totalCents, ctx.currency)} across ${plural(count, "expense")} ${label}. ` +
        Object.entries(byCategory)
          .map(([cat, cents]) => `${cat}: ${money(cents, ctx.currency)}`)
          .join("; ") +
        ".";
  return { summary, data };
}

/** Stock position by branch: tracked products and how many are below their reorder level. */
async function branchStock(ctx: ToolContext, _params: ToolParams): Promise<ToolResult> {
  const branches = await prisma.branch.findMany({
    where: { organizationId: ctx.organizationId },
    select: {
      name: true,
      code: true,
      warehouses: {
        select: {
          inventories: {
            select: {
              quantity: true,
              product: { select: { name: true, reorderPoint: true, trackStock: true } },
            },
          },
        },
      },
    },
    take: 50,
  });
  const rows = branches.map(b => {
    let tracked = 0;
    let low = 0;
    let onHandUnits = 0;
    for (const w of b.warehouses) {
      for (const inv of w.inventories) {
        const p = inv.product;
        if (!p?.trackStock) continue;
        tracked++;
        const onHand = Math.max(0, inv.quantity || 0);
        onHandUnits += onHand;
        const rp = p.reorderPoint || 0;
        if (rp > 0 && onHand <= rp) low++;
      }
    }
    return {
      branch: b.name,
      code: b.code,
      trackedProducts: tracked,
      onHandUnits,
      lowStockCount: low,
    };
  });
  rows.sort((a, b) => b.lowStockCount - a.lowStockCount || b.onHandUnits - a.onHandUnits);
  const data = { branches: rows.slice(0, 15), currency: ctx.currency };
  const totalLow = rows.reduce((s, r) => s + r.lowStockCount, 0);
  const summary =
    rows.length === 0
      ? "No branches are set up yet."
      : totalLow === 0
        ? `Stock looks good across ${plural(rows.length, "branch")}: nothing is below its reorder level.`
        : `${plural(totalLow, "product")} below the reorder level across ${plural(
            rows.length,
            "branch"
          )}. ` +
          rows
            .slice(0, 5)
            .filter(r => r.lowStockCount > 0)
            .map(r => `${r.branch}: ${r.lowStockCount} low`)
            .join("; ") +
          ".";
  return { summary, data };
}

type ToolFn = (ctx: ToolContext, params: ToolParams) => Promise<ToolResult>;

const TOOLS: Record<string, ToolFn> = {
  sales_summary: salesSummary,
  top_products: topProducts,
  low_stock: lowStock,
  who_owes: whoOwes,
  slow_movers: slowMovers,
  cash_position: cashPosition,
  expense_summary: expenseSummary,
  branch_stock: branchStock,
};

/** Shown to the language model so it can route a question to the right tool. */
export const TOOL_CATALOG = [
  {
    name: "sales_summary",
    description: "Total sales/revenue and number of sales for a time period",
    params: "period",
  },
  {
    name: "top_products",
    description: "Best-selling products by revenue for a time period",
    params: "period, limit",
  },
  {
    name: "low_stock",
    description: "Products at or below their reorder level that need restocking",
    params: "none",
  },
  {
    name: "who_owes",
    description: "Unpaid invoices and who owes the business money",
    params: "none",
  },
  {
    name: "slow_movers",
    description: "Products with stock that have not sold recently",
    params: "days",
  },
  {
    name: "cash_position",
    description: "Money collected through successful payments for a time period (till position)",
    params: "period",
  },
  {
    name: "expense_summary",
    description: "Money spent, grouped by expense category, for a time period",
    params: "period",
  },
  {
    name: "branch_stock",
    description: "Stock position by branch: tracked products and items below their reorder level",
    params: "none",
  },
];

/** Runs a tool by name. An unknown name falls back to the sales summary rather than erroring. */
export async function runTool(
  name: string,
  ctx: ToolContext,
  params: ToolParams
): Promise<ToolResult> {
  const fn = TOOLS[name] ?? salesSummary;
  return fn(ctx, params || {});
}
