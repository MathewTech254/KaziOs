import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, generateInvoiceNumber, paginate } from "../lib";
import { computeInvoiceTotals, fromCents } from "../lib/money";
import { zInvoiceSchema } from "@kazios/validation";
import { reverseSale, saleHasTrackedStock } from "../services/saleReturns";
import { recordManualEtims, submitEtimsInvoice } from "../services/etims/outbox";

const InvoiceStatus = {
  DRAFT: "DRAFT",
  SENT: "SENT",
  PARTIALLY_PAID: "PARTIALLY_PAID",
  PAID: "PAID",
  OVERDUE: "OVERDUE",
  VOID: "VOID",
} as const;

export const invoiceRouter = Router();

invoiceRouter.get(
  "/",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      const { page = 1, limit = 50, status, search } = req.query;
      const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
      const organizationId = req.organizationId;
      const isOwner = req.roles?.some(
        (r: any) => r.role.permissions.includes("*")
      ) ?? false;
      const isAttendant = req.roles?.some(
        (r: any) => r.role.permissions.includes("pos.sales.view")
      ) ?? false;

      if (!isOwner && !isAttendant) {
        throw new AppError(403, "Insufficient permissions");
      }

      const where: any = { organizationId };
      if (isAttendant) {
        // Attendants only see their own sales.
        where.recordedById = req.userId;
      }
      if (status) where.status = String(status);
      // A return has to find the sale by the number printed on the receipt, not only by
      // the customer: the person at the counter is holding paper, not a name.
      if (search) {
        const term = String(search);
        where.OR = [
          { customer: { name: { contains: term, mode: "insensitive" } } },
          { invoiceNumber: { contains: term, mode: "insensitive" } },
        ];
      }
      // The returns screen asks for this: a sale that is already void, or was never rung
      // up, has nothing to give back, and listing it only invites a 409.
      if (req.query.returnable === "true") {
        where.status = { notIn: [InvoiceStatus.VOID, InvoiceStatus.DRAFT] };
      }
      const [data, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          include: {
            customer: true,
            branch: true,
            items: true,
            payments: true,
            // The KRA side travels with the invoice: a business that has to show which
            // invoices are filed should not have to open each one to find out.
            etims: true,
          },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.invoice.count({ where }),
      ]);
      res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
    } catch (err) {
      next(err);
    }
  }
);

invoiceRouter.post(
  "/",
  requireAuth,
  requirePermission("invoices.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zInvoiceSchema.parse(req.body);

      // Every amount is derived here from quantity, unit price, discount and tax rate.
      // The client's subtotal, taxTotal, discountTotal and total are ignored: an invoice
      // that stores whatever the caller declared is not an accounting record, and the
      // stored lines would contradict the stored header.
      const totals = computeInvoiceTotals(
        data.items.map(item => ({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: item.discountAmount,
          taxRate: item.taxRate,
        }))
      );

      // A product on the invoice has to belong to this organization.
      const productIds = data.items
        .map(item => item.productId)
        .filter((id): id is string => Boolean(id));
      if (productIds.length) {
        const owned = await prisma.product.count({
          where: { id: { in: [...new Set(productIds)] }, organizationId: req.organizationId! },
        });
        if (owned !== new Set(productIds).size) {
          throw new AppError(400, "One or more products are not available in this organization");
        }
      }

      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, organizationId: req.organizationId! },
        select: { id: true },
      });
      if (!customer)
        throw new AppError(400, "The selected customer is not available in this organization");

      const invoice = await prisma.$transaction(async (tx: any) => {
        const inv = await tx.invoice.create({
          data: {
            invoiceNumber: generateInvoiceNumber(),
            organizationId: req.organizationId!,
            customerId: data.customerId,
            branchId: data.branchId || undefined,
            issueDate: new Date(data.issueDate),
            dueDate: new Date(data.dueDate),
            subtotal: fromCents(totals.subtotalCents),
            taxTotal: fromCents(totals.taxCents),
            discountTotal: fromCents(totals.discountCents),
            total: fromCents(totals.totalCents),
            currency: data.currency,
            notes: data.notes || undefined,
            terms: data.terms || undefined,
            paymentTerms: data.paymentTerms || undefined,
            status: InvoiceStatus.DRAFT,
          },
        });
        for (const [index, item] of data.items.entries()) {
          const line = totals.lines[index];
          await tx.invoiceItem.create({
            data: {
              invoiceId: inv.id,
              productId: item.productId || undefined,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discountAmount: fromCents(line.discountCents),
              taxRateId: item.taxRateId || undefined,
              taxAmount: fromCents(line.taxCents),
              lineTotal: fromCents(line.lineTotalCents),
            },
          });
        }
        return inv;
      });
      res.status(201).json({ data: invoice });
    } catch (err) {
      next(err);
    }
  }
);

invoiceRouter.get(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res, next) => {
    try {
      const isOwner = req.roles?.some(
        (r: any) => r.role.permissions.includes("*")
      ) ?? false;
      const isAttendant = req.roles?.some(
        (r: any) => r.role.permissions.includes("pos.sales.view")
      ) ?? false;

      if (!isOwner && !isAttendant) {
        throw new AppError(403, "Insufficient permissions");
      }

      const where: any = { id: req.params.id, organizationId: req.organizationId };
      if (isAttendant) {
        where.recordedById = req.userId;
      }
      const invoice = await prisma.invoice.findFirst({
        where,
        include: {
          customer: true,
          branch: true,
          items: { include: { product: true, taxCategory: true } },
          payments: true,
        },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");
      res.json({ data: invoice });
    } catch (err) {
      next(err);
    }
  }
);

invoiceRouter.post(
  "/:id/send",
  requireAuth,
  requirePermission("invoices.send"),
  async (req: AuthRequest, res, next) => {
    try {
      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (invoice.status !== InvoiceStatus.DRAFT)
        throw new AppError(400, "Only draft invoices can be sent");
      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.SENT },
      });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Void an invoice.
 *
 * Voiding used to flip the status and nothing else, which silently destroyed the stock:
 * the goods had left the shelf on the sale and no movement ever brought them back. An
 * invoice that took tracked stock now goes through the same reversal the till uses, and
 * needs the warehouse the goods return to. Invoices with no stock behind them (services,
 * manual billing) still void in one step.
 */
invoiceRouter.post(
  "/:id/void",
  requireAuth,
  requirePermission("invoices.void"),
  async (req: AuthRequest, res, next) => {
    try {
      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (invoice.status === InvoiceStatus.VOID)
        throw new AppError(409, "This invoice is already void");

      const holdsStock = await saleHasTrackedStock(invoice.id, req.organizationId!);
      if (!holdsStock) {
        const updated = await prisma.invoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.VOID },
        });
        res.json({ data: updated });
        return;
      }

      const warehouseId = typeof req.body?.warehouseId === "string" ? req.body.warehouseId : "";
      if (!warehouseId)
        throw new AppError(
          400,
          "This invoice moved stock. Name the warehouse the goods go back to so the shelf and the books stay together."
        );

      const result = await reverseSale({
        invoiceId: invoice.id,
        organizationId: req.organizationId!,
        warehouseId,
        reason: `Invoice voided ${invoice.invoiceNumber}`,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * File one invoice with KRA now.
 *
 * The row already exists from the sale, so this is a retry rather than a first attempt.
 * It answers with the submission whatever happened, so the caller can show either the
 * accepted number or the reason KRA refused it.
 */
invoiceRouter.post(
  "/:id/etims/submit",
  requireAuth,
  requirePermission("invoices.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
        select: { id: true },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");

      res.json({
        data: await submitEtimsInvoice(invoice.id, req.organizationId!),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Record a KRA invoice number somebody read off the portal.
 *
 * This is the fallback while eTIMS credentials are still being issued, and it is a real
 * filing: the number came from KRA. It does not submit anything on the business's behalf,
 * which is exactly why it exists — a business that cannot get an API key is not excused
 * from being able to prove its invoices were issued.
 */
invoiceRouter.post(
  "/:id/etims/manual",
  requireAuth,
  requirePermission("invoices.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
        select: { id: true },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");

      const kraInvoiceNumber = String(req.body?.kraInvoiceNumber ?? "").trim();
      const qrCode = typeof req.body?.qrCode === "string" ? req.body.qrCode : null;

      res.json({
        data: await recordManualEtims({
          invoiceId: invoice.id,
          organizationId: req.organizationId!,
          kraInvoiceNumber,
          qrCode,
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);
