import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, generateId, paginate } from "../lib";
import { zPaymentSchema } from "@kazios/validation";

const PaymentStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

export const paymentRouter = Router();

paymentRouter.get("/", requireAuth, requirePermission("payments.view"), async (req: AuthRequest, res, next) => {
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
      prisma.payment.findMany({ where, include: { customer: true, invoice: true, branch: true }, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.payment.count({ where }),
    ]);
    res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
  } catch (err) {
    next(err);
  }
});

paymentRouter.post("/", requireAuth, requirePermission("payments.create"), async (req: AuthRequest, res, next) => {
  try {
    const data = zPaymentSchema.parse(req.body);
    const payment = await prisma.payment.create({
      data: {
        reference: data.reference || generateId(),
        organizationId: req.organizationId!,
        amount: data.amount,
        currency: data.currency,
        provider: data.paymentProvider,
        methodType: data.paymentMethodType,
        status: PaymentStatus.PENDING,
        providerRef: data.reference || undefined,
        notes: data.notes || undefined,
        invoiceId: data.invoiceId || undefined,
        customerId: data.customerId || undefined,
        paidAt: new Date(),
      },
    });
    if (payment.invoiceId) {
      const agg = await prisma.payment.aggregate({
        where: { invoiceId: payment.invoiceId, status: PaymentStatus.SUCCESS },
        _sum: { amount: true },
      });
      const paid = agg._sum.amount || 0;
      const invoice = await prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
      if (invoice && paid >= invoice.total) {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAmount: paid } });
      } else if (invoice && paid > 0) {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "PARTIALLY_PAID", paidAmount: paid } });
      }
    }
    res.status(201).json({ data: payment });
  } catch (err) {
    next(err);
  }
});

paymentRouter.get("/:id", requireAuth, requirePermission("payments.view"), async (req, res, next) => {
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
});