import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export const reportRouter = Router();

reportRouter.get("/sales-summary", requireAuth, async (req, res, next) => {
  try {
    const startDate = req.query.startDate ? new Date(String(req.query.startDate)) : undefined;
    const endDate = req.query.endDate ? new Date(String(req.query.endDate)) : undefined;

    if ((req.query.startDate && Number.isNaN(startDate?.getTime())) || (req.query.endDate && Number.isNaN(endDate?.getTime()))) {
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
});
