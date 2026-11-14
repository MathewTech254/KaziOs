import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import {
  zDayClosingCloseSchema,
  zDayClosingOpenSchema,
  zDayClosingQuerySchema,
} from "@kazios/validation";

export const dayClosingRouter = Router();

/**
 * List day closings for the caller's organization.
 */
dayClosingRouter.get(
  "/",
  requireAuth,
  requirePermission("reports.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = zDayClosingQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid query");
      }
      const { startDate, endDate, status, page, limit } = parsed.data;
      const organizationId = req.organizationId!;
      const skip = (page - 1) * limit;

      const where: any = { organizationId };
      if (startDate) where.date = { ...(where.date || {}), gte: startDate };
      if (endDate) where.date = { ...(where.date || {}), lte: endDate };
      if (status) where.status = status;

      const [data, total] = await Promise.all([
        prisma.dayClosing.findMany({
          where,
          skip,
          take: limit,
          orderBy: { date: "desc" },
          include: {
            openedBy: { select: { id: true, name: true } },
            closedBy: { select: { id: true, name: true } },
          },
        }),
        prisma.dayClosing.count({ where }),
      ]);

      res.json({
        data,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Open a trading day. Creates a DayClosing with status OPEN. Idempotent: if a day
 * already exists for the date it is returned as-is.
 */
dayClosingRouter.post(
  "/open",
  requireAuth,
  requirePermission("closing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = zDayClosingOpenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid request");
      }
      const { date } = parsed.data;
      const organizationId = req.organizationId!;

      const existing = await prisma.dayClosing.findUnique({
        where: { organizationId_date: { organizationId, date } },
      });
      if (existing) {
        res.json({ data: existing });
        return;
      }

      const closing = await prisma.dayClosing.create({
        data: {
          date,
          status: "OPEN",
          openedById: req.userId!,
          organizationId,
        },
        include: {
          openedBy: { select: { id: true, name: true } },
        },
      });
      res.status(201).json({ data: closing });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Close a trading day. Sets status to CLOSED, records the owner's physical counts
 * and computes the difference. Only the owner (closing.manage) can close.
 */
dayClosingRouter.post(
  "/close",
  requireAuth,
  requirePermission("closing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = zDayClosingCloseSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid request");
      }
      const { date, countedCash, countedMpesa, notes } = parsed.data;
      const organizationId = req.organizationId!;

      const existing = await prisma.dayClosing.findUnique({
        where: { organizationId_date: { organizationId, date } },
      });
      if (!existing) {
        throw new AppError(404, "No open day found for this date");
      }
      if (existing.status !== "OPEN") {
        throw new AppError(409, `Day is already ${existing.status.toLowerCase()}`);
      }

      // Compute expected cash and M-PESA from completed sales today.
      const dayStart = new Date(`${date}T00:00:00`);
      const dayEnd = new Date(`${date}T23:59:59.999`);

      const [cashPayments, mpesaPayments] = await Promise.all([
        prisma.payment.aggregate({
          where: {
            organizationId,
            provider: "CASH",
            status: "SUCCESS",
            createdAt: { gte: dayStart, lte: dayEnd },
          },
          _sum: { amount: true },
        }),
        prisma.payment.aggregate({
          where: {
            organizationId,
            provider: "MPESA_MANUAL",
            status: "SUCCESS",
            createdAt: { gte: dayStart, lte: dayEnd },
          },
          _sum: { amount: true },
        }),
        prisma.payment.aggregate({
          where: {
            organizationId,
            provider: "CREDIT",
            status: "SUCCESS",
            invoiceId: null,
            createdAt: { gte: dayStart, lte: dayEnd },
          },
          _sum: { amount: true },
        }),
      ]);

      const expectedCash = Number(cashPayments._sum.amount || 0);
      const expectedMpesa = Number(mpesaPayments._sum.amount || 0);

      const closing = await prisma.dayClosing.update({
        where: { id: existing.id },
        data: {
          status: "CLOSED",
          closedById: req.userId,
          closedAt: new Date(),
          expectedCash,
          countedCash,
          expectedMpesa,
          countedMpesa,
          difference: countedCash - expectedCash + countedMpesa - expectedMpesa,
          notes,
        },
        include: {
          openedBy: { select: { id: true, name: true } },
          closedBy: { select: { id: true, name: true } },
        },
      });
      res.json({ data: closing });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Reopen a closed day. Only the owner (closing.manage) can reopen.
 */
dayClosingRouter.post(
  "/reopen",
  requireAuth,
  requirePermission("closing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = zDayClosingOpenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid request");
      }
      const { date } = parsed.data;
      const organizationId = req.organizationId!;

      const existing = await prisma.dayClosing.findUnique({
        where: { organizationId_date: { organizationId, date } },
      });
      if (!existing) {
        throw new AppError(404, "No day closing found for this date");
      }
      if (existing.status !== "CLOSED") {
        throw new AppError(409, `Day is ${existing.status.toLowerCase()}, not closed`);
      }

      const closing = await prisma.dayClosing.update({
        where: { id: existing.id },
        data: {
          status: "REOPENED",
          closedById: null,
          closedAt: null,
        },
        include: {
          openedBy: { select: { id: true, name: true } },
          closedBy: { select: { id: true, name: true } },
        },
      });
      res.json({ data: closing });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Closing report for a single date. Everything computed from the database on demand.
 */
dayClosingRouter.get(
  "/report",
  requireAuth,
  requirePermission("reports.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const date = String(req.query.date || "");
      if (!date || date.length !== 10) {
        throw new AppError(400, "Date is required (YYYY-MM-DD)");
      }
      const organizationId = req.organizationId!;

      const dayStart = new Date(`${date}T00:00:00`);
      const dayEnd = new Date(`${date}T23:59:59.999`);

      const dayClosing = await prisma.dayClosing.findUnique({
        where: { organizationId_date: { organizationId, date } },
      });

      // All invoices (not void) created today.
      const invoices = await prisma.invoice.findMany({
        where: {
          organizationId,
          status: { not: "VOID" },
          createdAt: { gte: dayStart, lte: dayEnd },
        },
        include: {
          items: { select: { productId: true, quantity: true, lineTotal: true } },
          payments: { select: { amount: true, provider: true, status: true } },
          customer: { select: { id: true, name: true } },
        },
      });

      // Aggregate totals.
      let totalSales = 0;
      let cashSales = 0;
      let mpesaSales = 0;
      let creditSales = 0;
      let refundsVoids = 0;

      for (const inv of invoices) {
        totalSales += Number(inv.total || 0);
        if (inv.status === "VOID" || inv.status === "REFUNDED") {
          refundsVoids += Number(inv.total || 0);
        }
        for (const p of inv.payments) {
          if (p.status !== "SUCCESS") continue;
          if (p.provider === "CASH") cashSales += Number(p.amount || 0);
          else if (p.provider === "MPESA_MANUAL") mpesaSales += Number(p.amount || 0);
          else if (p.provider === "CREDIT") creditSales += Number(p.amount || 0);
        }
      }

      // Per-attendant sales totals. Invoice doesn't store the recording user
      // in v1, so per-attendant breakdown is not available yet.
      const perAttendant: {
        attendantId: string | null;
        attendantName: string;
        totalSales: number;
        transactionCount: number;
      }[] = [];

      // Items sold today.
      const itemsSold = await prisma.invoiceItem.groupBy({
        by: ["productId"],
        where: {
          invoice: {
            organizationId,
            status: { not: "VOID" },
            createdAt: { gte: dayStart, lte: dayEnd },
          },
        },
        _sum: { quantity: true, lineTotal: true },
      });

      const soldProductIds = itemsSold.map((r: any) => r.productId).filter(Boolean);
      const soldProducts =
        soldProductIds.length > 0
          ? await prisma.product.findMany({
              where: { id: { in: soldProductIds }, organizationId },
              select: { id: true, name: true, sku: true },
            })
          : [];
      const productById = new Map(soldProducts.map(p => [p.id, p]));

      // Expenses today.
      const expenses = await prisma.expense.findMany({
        where: {
          organizationId,
          status: { not: "VOIDED" },
          expenseDate: { gte: dayStart, lte: dayEnd },
        },
        select: { id: true, vendorName: true, amount: true, notes: true, createdAt: true },
      });

      const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

      // Low stock based on reorder_level.
      const lowStock = await prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM "Inventory" i
        JOIN "Product" p ON p.id = i."productId"
        WHERE i."organizationId" = ${organizationId}
          AND p."isActive" = true AND p."trackStock" = true
          AND (i.quantity - i.reserved) > 0 AND (i.quantity - i.reserved) <= p."minStock"
      `;

      // Stockouts today: adjustments with reason indicating loss.
      const stockShortages = await prisma.stockMovement.count({
        where: {
          organizationId,
          type: "ADJUSTMENT",
          createdAt: { gte: dayStart, lte: dayEnd },
          reason: { in: ["damage", "breakage", "expired", "theft"] },
        },
      });

      res.json({
        data: {
          date,
          status: dayClosing?.status || "NOT_OPENED",
          totals: {
            totalSales,
            cashSales,
            mpesaSales,
            creditSales,
            refundsVoids,
            totalExpenses,
            net: totalSales - totalExpenses,
          },
          dayClosing,
          perAttendant,
          itemsSold: itemsSold.map((r: any) => ({
            productId: r.productId,
            productName: productById.get(r.productId)?.name || "Unknown",
            sku: productById.get(r.productId)?.sku || null,
            quantity: Number(r._sum.quantity || 0),
            lineTotal: Number(r._sum.lineTotal || 0),
          })),
          expenses,
          lowStock: lowStock[0]?.count ?? 0,
          stockShortages,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
