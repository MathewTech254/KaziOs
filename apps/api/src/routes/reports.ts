import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";

export const reportRouter = Router();

/**
 * One keystroke, every list. Searches the entities a user actually hunts for
 * mid-task and returns a small slice of each, scoped to the caller's organization.
 */
reportRouter.get("/search", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const organizationId = req.organizationId!;
    const term = String(req.query.q ?? "").trim();
    if (term.length < 2) {
      res.json({ data: { query: term, results: [] } });
      return;
    }

    const contains = { contains: term, mode: "insensitive" as const };
    // A two character term would match a large slice of any table, so guard the fan out.
    const take = 5;

    const [products, suppliers, customers, orders, invoices] = await Promise.all([
      prisma.product.findMany({
        where: {
          organizationId,
          OR: [{ name: contains }, { sku: contains }, { barcode: contains }],
        },
        select: { id: true, name: true, sku: true, costPrice: true, sellingPrice: true },
        take,
        orderBy: { name: "asc" },
      }),
      prisma.supplier.findMany({
        where: {
          organizationId,
          OR: [{ name: contains }, { email: contains }, { phone: contains }],
        },
        select: { id: true, name: true, email: true, phone: true },
        take,
        orderBy: { name: "asc" },
      }),
      prisma.customer.findMany({
        where: {
          organizationId,
          OR: [{ name: contains }, { email: contains }, { phone: contains }],
        },
        select: { id: true, name: true, email: true, phone: true },
        take,
        orderBy: { name: "asc" },
      }),
      prisma.purchaseOrder.findMany({
        where: { organizationId, OR: [{ poNumber: contains }, { notes: contains }] },
        select: {
          id: true,
          poNumber: true,
          status: true,
          totalAmount: true,
          supplier: { select: { name: true } },
        },
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.invoice.findMany({
        where: { organizationId, OR: [{ invoiceNumber: contains }, { notes: contains }] },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          total: true,
          customer: { select: { name: true } },
        },
        take,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    res.json({
      data: {
        query: term,
        results: { products, suppliers, customers, purchaseOrders: orders, invoices },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The opening screen. Everything here is counted in the database rather than assembled
 * in the browser, because a dashboard showing a number nobody can trace back to a
 * transaction is decoration.
 *
 * Aggregated rather than loaded: loading this month's invoices to add up a total would
 * mean pulling tens of thousands of rows to produce eight figures, and would get slower
 * every month the business trades.
 */
reportRouter.get(
  "/dashboard",
  requireAuth,
  requirePermission("reports.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;
      // Midnight in the organization's own timezone, not the server's. A business in
      // Nairobi whose server runs in UTC sees "today" as yesterday evening, which makes
      // the whole day's takings look wrong for a third of the day.
      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true, timezone: true },
      });
      const timeZone = organization?.timezone || "UTC";

      /** Midnight, in the organization's timezone, for `offsetDays` from now. */
      const zonedDayStart = (offsetDays = 0) => {
        // en-CA renders as YYYY-MM-DD, which is exactly the format needed to rebuild a
        // local calendar day without hand assembling the string.
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        const start = new Date(`${local}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() + offsetDays);
        return start;
      };

      const now = new Date();
      const dayStart = zonedDayStart(0);
      const dayEnd = zonedDayStart(1);
      const monthStart = new Date(
        `${new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
        }).format(now)}-01T00:00:00Z`
      );

      // A sale counts as revenue once it is not draft or void. A card sale sits in SENT
      // until Paystack confirms the money, and counting it as revenue the moment the till
      // rang it up is how a dashboard starts claiming takings that never arrived.
      const revenueStatuses = ["SENT", "PAID", "PARTIALLY_PAID", "OVERDUE"];
      const inRange = { gte: dayStart, lt: dayEnd };
      const todayWhere = { organizationId, status: { in: revenueStatuses }, createdAt: inRange };
      const monthWhere = {
        organizationId,
        status: { in: revenueStatuses },
        createdAt: { gte: monthStart },
      };

      const [
        todayRevenue,
        todayCount,
        monthRevenue,
        monthCount,
        monthExpenses,
        receivables,
        overdueCount,
        lowStock,
        outOfStock,
        recent,
        topItems,
      ] = await Promise.all([
        prisma.invoice.aggregate({ where: todayWhere, _sum: { total: true } }),
        prisma.invoice.count({ where: todayWhere }),
        prisma.invoice.aggregate({ where: monthWhere, _sum: { total: true } }),
        prisma.invoice.count({ where: monthWhere }),
        // Voided spend is excluded, exactly as the expense report does. A voided figure
        // still counted here would contradict the expenses screen beside it.
        prisma.expense.aggregate({
          where: { organizationId, status: { not: "VOIDED" }, expenseDate: { gte: monthStart } },
          _sum: { amount: true },
        }),
        prisma.invoice.aggregate({
          where: { organizationId, status: { in: ["SENT", "PARTIALLY_PAID", "OVERDUE"] } },
          _sum: { total: true, paidAmount: true },
        }),
        prisma.invoice.count({ where: { organizationId, status: "OVERDUE" } }),
        prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "Inventory" i
          JOIN "Product" p ON p.id = i."productId"
          WHERE i."organizationId" = ${organizationId}
            AND p."isActive" = true AND p."trackStock" = true
            AND (i.quantity - i.reserved) > 0 AND (i.quantity - i.reserved) <= p."minStock"
        `,
        prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "Inventory" i
          JOIN "Product" p ON p.id = i."productId"
          WHERE i."organizationId" = ${organizationId}
            AND p."isActive" = true AND p."trackStock" = true
            AND (i.quantity - i.reserved) <= 0
        `,
        prisma.invoice.findMany({
          where: { organizationId, status: { in: revenueStatuses } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            invoiceNumber: true,
            total: true,
            status: true,
            paidAmount: true,
            createdAt: true,
            customer: { select: { name: true } },
            branch: { select: { name: true } },
          },
        }),
        prisma.invoiceItem.groupBy({
          by: ["productId"],
          where: {
            invoice: {
              organizationId,
              status: { in: revenueStatuses },
              createdAt: { gte: monthStart },
            },
            productId: { not: null },
          },
          _sum: { quantity: true, lineTotal: true },
          orderBy: { _sum: { lineTotal: "desc" } },
          take: 5,
        }),
      ]);

      // Names are resolved separately because groupBy cannot join a relation, and the
      // alternative is shipping five ids to the browser and making it fetch them.
      const productIds = topItems.map(row => row.productId).filter((id): id is string => !!id);
      const products = productIds.length
        ? await prisma.product.findMany({
            where: { id: { in: productIds }, organizationId },
            select: { id: true, name: true, sku: true },
          })
        : [];
      const productById = new Map(products.map(product => [product.id, product]));

      const round = (value: number | null | undefined) => Math.round((value || 0) * 100) / 100;
      const monthRevenueTotal = round(monthRevenue._sum.total);
      const monthExpenseTotal = round(monthExpenses._sum.amount);

      res.json({
        data: {
          currency: organization?.currency || "KES",
          today: { revenue: round(todayRevenue._sum.total), transactions: todayCount },
          month: {
            revenue: monthRevenueTotal,
            expenses: monthExpenseTotal,
            // What is left after recorded spend. Cost of goods is not subtracted again
            // here: it is already inside the margin the sale price was set at, and
            // deducting it twice is the classic way a shop dashboard understates profit.
            profit: round(monthRevenueTotal - monthExpenseTotal),
            transactions: monthCount,
            averageOrderValue: monthCount ? round(monthRevenueTotal / monthCount) : 0,
          },
          receivables: {
            outstanding: round((receivables._sum.total || 0) - (receivables._sum.paidAmount || 0)),
            overdueInvoices: overdueCount,
          },
          stock: { lowStock: lowStock[0]?.count ?? 0, outOfStock: outOfStock[0]?.count ?? 0 },
          recentInvoices: recent,
          topProducts: topItems.map(row => {
            const product = row.productId ? productById.get(row.productId) : undefined;
            return {
              productId: row.productId,
              name: product?.name || "Unknown product",
              sku: product?.sku || null,
              quantity: round(row._sum.quantity),
              revenue: round(row._sum.lineTotal),
            };
          }),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

reportRouter.get(
  "/sales-summary",
  requireAuth,
  requirePermission("reports.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : undefined;
      const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : undefined;

      if (
        (req.query.startDate && Number.isNaN(startDate?.getTime())) ||
        (req.query.endDate && Number.isNaN(endDate?.getTime()))
      ) {
        res.status(400).json({ error: "Invalid date range" });
        return;
      }

      const where = {
        organizationId: req.organizationId,
        createdAt: {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lte: endDate } : {}),
        },
      };

      const [totalInvoices, totals, totalPayments] = await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.aggregate({
          where,
          _sum: { total: true, taxTotal: true, discountTotal: true },
        }),
        prisma.payment.count({
          where: {
            organizationId: req.organizationId,
            status: "SUCCESS",
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          },
        }),
      ]);

      res.json({
        data: {
          totalInvoices,
          totalRevenue: totals._sum.total || 0,
          totalTax: totals._sum.taxTotal || 0,
          totalDiscounts: totals._sum.discountTotal || 0,
          totalPayments: totalPayments,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
