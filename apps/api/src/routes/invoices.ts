import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, generateInvoiceNumber, paginate } from "../lib";
import { zInvoiceSchema } from "@kazios/validation";

const InvoiceStatus = {
  DRAFT: "DRAFT",
  SENT: "SENT",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
  OVERDUE: "OVERDUE",
  VOID: "VOID",
} as const;

export const invoiceRouter = Router();

invoiceRouter.get("/", requireAuth, requirePermission("invoices.view"), async (req: AuthRequest, res, next) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
    const where: any = { organizationId: req.organizationId };
    if (status) where.status = String(status);
    if (search) where.customer = { name: { contains: String(search), mode: "insensitive" } };
    const [data, total] = await Promise.all([
      prisma.invoice.findMany({ where, include: { customer: true, branch: true, items: true, payments: true }, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.invoice.count({ where }),
    ]);
    res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
  } catch (err) {
    next(err);
  }
});

invoiceRouter.post("/", requireAuth, requirePermission("invoices.create"), async (req: AuthRequest, res, next) => {
  try {
    const data = zInvoiceSchema.parse(req.body);
    const invoice = await prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.create({
        data: {
          invoiceNumber: generateInvoiceNumber(),
          organizationId: req.organizationId!,
          customerId: data.customerId,
          branchId: data.branchId || undefined,
          issueDate: new Date(data.issueDate),
          dueDate: new Date(data.dueDate),
          subtotal: data.subtotal,
          taxTotal: data.taxTotal,
          discountTotal: data.discountTotal,
          total: data.total,
          currency: data.currency,
          notes: data.notes || undefined,
          terms: data.terms || undefined,
          paymentTerms: data.paymentTerms || undefined,
          status: InvoiceStatus.DRAFT,
        },
      });
      for (const item of data.items) {
        await tx.invoiceItem.create({
          data: {
            invoiceId: inv.id,
            productId: item.productId || undefined,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountAmount: item.discountAmount,
            taxRateId: item.taxRateId || undefined,
            taxAmount: item.taxAmount,
            lineTotal: item.lineTotal,
          },
        });
      }
      return inv;
    });
    res.status(201).json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

invoiceRouter.get("/:id", requireAuth, requirePermission("invoices.view"), async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
      include: { customer: true, branch: true, items: { include: { product: true, taxCategory: true } }, payments: true },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    res.json({ data: invoice });
  } catch (err) {
    next(err);
  }
});

invoiceRouter.post("/:id/send", requireAuth, requirePermission("invoices.send"), async (req: AuthRequest, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status !== InvoiceStatus.DRAFT) throw new AppError(400, "Only draft invoices can be sent");
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.SENT },
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

invoiceRouter.post("/:id/void", requireAuth, requirePermission("invoices.void"), async (req: AuthRequest, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.VOID },
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});