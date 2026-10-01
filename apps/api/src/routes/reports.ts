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
