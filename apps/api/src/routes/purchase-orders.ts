import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zPurchaseOrderQuerySchema, zPurchaseOrderSchema, zPurchaseOrderUpdateSchema } from "@kazios/validation";
import {
  assertOrderItemsValid,
  assertSupplierInOrg,
  assertWarehouseInOrg,
  calculateOrderTotals,
  generateUniquePoNumber,
  OrderLineInput,
} from "../services/purchaseOrders";

export const purchaseOrderRouter = Router();

const listInclude = {
  supplier: { select: { id: true, name: true, email: true, phone: true } },
  warehouse: { select: { id: true, name: true, code: true } },
  _count: { select: { items: true } },
} satisfies Prisma.PurchaseOrderInclude;

const detailInclude = {
  supplier: true,
  warehouse: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true } },
  items: {
    orderBy: { id: "asc" },
    include: { product: { select: { id: true, name: true, sku: true, unitId: true } } },
  },
} satisfies Prisma.PurchaseOrderInclude;

type CreateInput = z.infer<typeof zPurchaseOrderSchema>;

/** Shared create path so POST and any future copy action cannot diverge. */
async function createPurchaseOrder(organizationId: string, userId: string | undefined, input: CreateInput) {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
  const currency = (input.currency || organization?.currency || "USD").toUpperCase();

  await assertSupplierInOrg(organizationId, input.supplierId);
  await assertWarehouseInOrg(organizationId, input.warehouseId);
  await assertOrderItemsValid(organizationId, input.items as OrderLineInput[]);

  const totals = calculateOrderTotals(input.items as OrderLineInput[], input.taxRate);
  const poNumber = await generateUniquePoNumber();

  return prisma.purchaseOrder.create({
    data: {
      poNumber,
      status: "DRAFT",
      organizationId,
      supplierId: input.supplierId,
      warehouseId: input.warehouseId || null,
      branchId: input.branchId || null,
      expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
      notes: input.notes?.trim() || null,
      currency,
      subtotal: totals.subtotal,
      taxRate: totals.taxRate,
      taxTotal: totals.taxTotal,
      totalAmount: totals.totalAmount,
      createdById: userId || null,
      items: {
        create: totals.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          description: line.description?.trim() || null,
        })),
      },
    },
    include: detailInclude,
  });
}

purchaseOrderRouter.get(
  "/",
  requireAuth,
  requirePermission("purchasing.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;
      const query = zPurchaseOrderQuerySchema.parse(req.query);
      const { skip, take, page, limit } = paginate(query.page, query.limit);

      const where: Prisma.PurchaseOrderWhereInput = { organizationId };
      if (query.status !== "ALL") where.status = query.status;
      if (query.supplierId) where.supplierId = query.supplierId;
      if (query.search) {
        const term = query.search.trim();
        where.OR = [
          { poNumber: { contains: term, mode: "insensitive" } },
          { notes: { contains: term, mode: "insensitive" } },
          { supplier: { name: { contains: term, mode: "insensitive" } } },
        ];
      }

      const [data, total, counts] = await Promise.all([
        prisma.purchaseOrder.findMany({ where, include: listInclude, orderBy: { createdAt: "desc" }, skip, take }),
        prisma.purchaseOrder.count({ where }),
        prisma.purchaseOrder.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
      ]);

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          byStatus: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

purchaseOrderRouter.post(
  "/",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const input = zPurchaseOrderSchema.parse(req.body);
      const order = await createPurchaseOrder(req.organizationId!, req.userId, input);
      res.status(201).json({ data: order });
    } catch (err) {
      next(err);
    }
  }
);

purchaseOrderRouter.get(
  "/:id",
  requireAuth,
  requirePermission("purchasing.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const order = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        include: detailInclude,
      });
      if (!order) throw new AppError(404, "Purchase order not found");
      res.json({ data: order });
    } catch (err) {
      next(err);
    }
  }
);

/** Drafts are freely editable; once sent the document is locked. */
purchaseOrderRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const input = zPurchaseOrderUpdateSchema.parse(req.body);
      const current = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        select: { id: true, status: true, currency: true, taxRate: true },
      });
      if (!current) throw new AppError(404, "Purchase order not found");
      if (current.status !== "DRAFT") {
        throw new AppError(409, `This purchase order is ${current.status.toLowerCase()} and can no longer be edited`, "PO_LOCKED");
      }

      if (input.supplierId) await assertSupplierInOrg(req.organizationId!, input.supplierId);
      if (input.warehouseId !== undefined) await assertWarehouseInOrg(req.organizationId!, input.warehouseId);

      const order = await prisma.$transaction(async (tx) => {
        const updated = await tx.purchaseOrder.update({
          where: { id: current.id },
          data: {
            ...(input.supplierId ? { supplierId: input.supplierId } : {}),
            ...(input.branchId !== undefined ? { branchId: input.branchId || null } : {}),
            ...(input.warehouseId !== undefined ? { warehouseId: input.warehouseId || null } : {}),
            ...(input.expectedDate !== undefined
              ? { expectedDate: input.expectedDate ? new Date(input.expectedDate) : null }
              : {}),
            ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
            ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
          },
        });

        if (!input.items) return tx.purchaseOrder.findUniqueOrThrow({ where: { id: updated.id }, include: detailInclude });

        await assertOrderItemsValid(req.organizationId!, input.items as OrderLineInput[]);
        const totals = calculateOrderTotals(input.items as OrderLineInput[], input.taxRate ?? current.taxRate);
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: updated.id } });
        await tx.purchaseOrderItem.createMany({
          data: totals.lines.map((line) => ({
            purchaseOrderId: updated.id,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            description: line.description?.trim() || null,
          })),
        });
        await tx.purchaseOrder.update({
          where: { id: updated.id },
          data: {
            subtotal: totals.subtotal,
            taxRate: totals.taxRate,
            taxTotal: totals.taxTotal,
            totalAmount: totals.totalAmount,
          },
        });

        return tx.purchaseOrder.findUniqueOrThrow({ where: { id: updated.id }, include: detailInclude });
      });

      res.json({ data: order });
    } catch (err) {
      next(err);
    }
  }
);

async function findOrder(organizationId: string, id: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id, organizationId },
    include: detailInclude,
  });
  if (!order) throw new AppError(404, "Purchase order not found");
  return order;
}

/** DRAFT -> SENT. Marks the document as issued to the supplier. */
purchaseOrderRouter.post(
  "/:id/send",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const order = await findOrder(req.organizationId!, req.params.id);
      if (order.status !== "DRAFT") {
        throw new AppError(409, `Only a draft can be sent, this one is ${order.status.toLowerCase()}`, "PO_STATUS");
      }

      const sent = await prisma.purchaseOrder.updateMany({
        where: { id: order.id, status: "DRAFT" },
        data: { status: "SENT", sentAt: new Date() },
      });
      if (sent.count !== 1) throw new AppError(409, "This purchase order was already processed", "PO_STATUS");

      res.json({ data: await findOrder(req.organizationId!, order.id) });
    } catch (err) {
      next(err);
    }
  }
);

/** DRAFT or SENT -> CANCELLED. Goods are never received against a cancelled order. */
purchaseOrderRouter.post(
  "/:id/cancel",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const order = await findOrder(req.organizationId!, req.params.id);
      if (order.status !== "DRAFT" && order.status !== "SENT") {
        throw new AppError(409, `This purchase order is ${order.status.toLowerCase()} and cannot be cancelled`, "PO_STATUS");
      }

      const cancelled = await prisma.purchaseOrder.updateMany({
        where: { id: order.id, status: { in: ["DRAFT", "SENT"] } },
        data: { status: "CANCELLED" },
      });
      if (cancelled.count !== 1) throw new AppError(409, "This purchase order was already processed", "PO_STATUS");

      res.json({ data: await findOrder(req.organizationId!, order.id) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * An order can be removed only while it was never sent. A cancelled order is safe to
 * delete because no goods and no issued document can ever be tied to it.
 */
purchaseOrderRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const order = await findOrder(req.organizationId!, req.params.id);
      if (order.status !== "DRAFT" && order.status !== "CANCELLED") {
        throw new AppError(409, "Only a draft or cancelled order can be deleted, cancel it instead", "PO_STATUS");
      }

      await prisma.purchaseOrder.delete({ where: { id: order.id } });
      res.json({ data: { id: order.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);
