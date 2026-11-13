import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, generateId, paginate } from "../lib";
import { zPaymentSchema } from "@kazios/validation";
import { notifyPermissionHolders } from "../services/notifications";

const PaymentStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

export const paymentRouter = Router();

paymentRouter.get(
  "/",
  requireAuth,
  requirePermission("payments.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const { page = 1, limit = 50, search, status, provider } = req.query;
      const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
      const where: any = { organizationId: req.organizationId };
      if (status && String(status) !== "ALL") where.status = String(status);
      if (provider && String(provider) !== "ALL") where.provider = String(provider);
      // The payments screen offers a search box, so honour the term instead of ignoring it.
      if (search && String(search).trim()) {
        const term = String(search).trim();
        where.OR = [
          { reference: { contains: term, mode: "insensitive" } },
          { providerRef: { contains: term, mode: "insensitive" } },
          { notes: { contains: term, mode: "insensitive" } },
          { customer: { name: { contains: term, mode: "insensitive" } } },
          { invoice: { invoiceNumber: { contains: term, mode: "insensitive" } } },
        ];
      }
      const [data, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          include: { customer: true, invoice: true, branch: true },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.payment.count({ where }),
      ]);
      res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
    } catch (err) {
      next(err);
    }
  }
);

paymentRouter.post(
  "/",
  requireAuth,
  requirePermission("payments.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zPaymentSchema.parse(req.body);

      // CREDIT payments are manual repayments (cash or M-PESA code) and are
      // successful immediately — there is no external provider to wait for.
      const isCreditRepayment =
        data.paymentProvider === "CREDIT" && data.paymentMethodType === "credit";

      // Reject overpayments: a repayment cannot exceed the customer's current
      // outstanding balance. Balance = unpaid invoice totals − standalone repayments.
      // Check BEFORE creating the payment so the payment isn't counted in its own check.
      if (isCreditRepayment && data.customerId) {
        const [invoices, repayments] = await Promise.all([
          prisma.invoice.aggregate({
            where: {
              customerId: data.customerId,
              organizationId: req.organizationId!,
              status: { not: "VOID" },
            },
            _sum: { total: true, paidAmount: true },
          }),
          prisma.payment.aggregate({
            where: {
              customerId: data.customerId,
              organizationId: req.organizationId!,
              provider: "CREDIT",
              invoiceId: null,
              status: PaymentStatus.SUCCESS,
            },
            _sum: { amount: true },
          }),
        ]);

        const owed =
          Number(invoices._sum.total ?? 0) - Number(invoices._sum.paidAmount ?? 0);
        const repaid = Number(repayments._sum.amount ?? 0);
        const currentBalance = owed - repaid;

        if (data.amount > currentBalance) {
          throw new AppError(
            400,
            `Repayment of ${data.currency} ${data.amount.toFixed(2)} exceeds outstanding balance of ${data.currency} ${currentBalance.toFixed(2)}`
          );
        }
      }

      const payment = await prisma.payment.create({
        data: {
          reference: data.reference || generateId(),
          organizationId: req.organizationId!,
          amount: data.amount,
          currency: data.currency,
          provider: data.paymentProvider,
          methodType: data.paymentMethodType,
          status: isCreditRepayment ? PaymentStatus.SUCCESS : PaymentStatus.PENDING,
          providerRef: data.reference || undefined,
          notes: data.notes || undefined,
          invoiceId: data.invoiceId || undefined,
          customerId: data.customerId || undefined,
          paidAt: new Date(),
        },
      });
      // The invoice settled, or moved closer to settling. Whoever watches the books is
      // told without having to reload the payments screen.
      if (payment.invoiceId) {
        const agg = await prisma.payment.aggregate({
          where: { invoiceId: payment.invoiceId, status: PaymentStatus.SUCCESS },
          _sum: { amount: true },
        });
        const paid = agg._sum.amount || 0;
        const invoice = await prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
        if (invoice && paid >= invoice.total) {
          await prisma.invoice.update({
            where: { id: invoice.id },
            data: { status: "PAID", paidAmount: paid },
          });
        } else if (invoice && paid > 0) {
          await prisma.invoice.update({
            where: { id: invoice.id },
            data: { status: "PARTIALLY_PAID", paidAmount: paid },
          });
        }

        if (invoice) {
          const settled = Boolean(invoice && paid >= invoice.total);
          await notifyPermissionHolders({
            organizationId: req.organizationId!,
            permission: "payments.view",
            title: settled ? "Invoice paid in full" : "Payment received",
            body: settled
              ? `${invoice.invoiceNumber} is now fully paid (${invoice.currency} ${paid.toFixed(2)}).`
              : `${invoice.invoiceNumber} is part paid: ${invoice.currency} ${paid.toFixed(2)} of ${invoice.total.toFixed(2)}.`,
            type: "success",
            link: "/dashboard/payments",
            excludeUserIds: [req.userId!],
          }).catch(() => 0);
        }
      }
      res.status(201).json({ data: payment });
    } catch (err) {
      next(err);
    }
  }
);

paymentRouter.get(
  "/:id",
  requireAuth,
  requirePermission("payments.view"),
  async (req, res, next) => {
    try {
      const payment = await prisma.payment.findFirst({
        where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
        include: { customer: true, invoice: true },
      });
      if (!payment) throw new AppError(404, "Payment not found");
      res.json({ data: payment });
    } catch (err) {
      next(err);
    }
  }
);
