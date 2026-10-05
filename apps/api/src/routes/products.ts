import { Router } from "express";
import type { z } from "zod";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zProductSchema } from "@kazios/validation";
import { LIMIT_KEYS } from "@kazios/types";
import { assertWithinLimit, getEntitlements } from "../services/entitlements";

export const productRouter = Router();

/** PATCH sends only the fields the user changed, so absent keys must stay absent. */
function toProductPatch(input: Partial<z.infer<typeof zProductSchema>>) {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) data[key] = value;
  }
  return data;
}

productRouter.get(
  "/",
  requireAuth,
  requirePermission("products.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const { page = 1, limit = 50, search, productType } = req.query;
      const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
      const where: any = { organizationId: req.organizationId };
      // A till operator scans a barcode or reads a sku, so those count as a match too.
      if (search) {
        const term = String(search);
        where.OR = [
          { name: { contains: term, mode: "insensitive" } },
          { sku: { contains: term, mode: "insensitive" } },
          { barcode: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
        ];
      }
      if (productType) where.productType = String(productType);

      const [data, total] = await Promise.all([
        prisma.product.findMany({
          where,
          include: { taxCategory: true, brand: true, unit: true },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.product.count({ where }),
      ]);
      res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.post(
  "/",
  requireAuth,
  requirePermission("products.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zProductSchema.parse(req.body);

      // The catalogue is a counted allowance. Checked before the row is written, so a
      // refused request leaves nothing behind and the count the customer sees in billing
      // is the count in the table.
      const entitlements = await getEntitlements(req.organizationId!);
      await assertWithinLimit(entitlements, LIMIT_KEYS.PRODUCTS);

      const product = await prisma.product.create({
        data: {
          name: data.name,
          sku: data.sku || undefined,
          barcode: data.barcode || undefined,
          description: data.description || undefined,
          costPrice: data.costPrice,
          sellingPrice: data.sellingPrice,
          minStock: data.minStock,
          reorderPoint: data.reorderPoint,
          isActive: data.isActive,
          productType: data.productType,
          organizationId: req.organizationId!,
          taxCategoryId: (data as any).taxCategoryId || undefined,
          brandId: (data as any).brandId || undefined,
          unitId: (data as any).unitId || undefined,
        },
      });
      res.status(201).json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.get(
  "/:id",
  requireAuth,
  requirePermission("products.view"),
  async (req, res, next) => {
    try {
      const product = await prisma.product.findFirst({
        where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
        include: {
          taxCategory: true,
          brand: true,
          unit: true,
          inventories: { include: { warehouse: true } },
        },
      });
      if (!product) throw new AppError(404, "Product not found");
      res.json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("products.update"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zProductSchema.partial().parse(req.body);
      // Resolve within the caller's organization first. The old update used a bare id and
      // also rewrote organizationId, so one tenant could edit and then steal another
      // tenant's product.
      const current = await prisma.product.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        select: { id: true },
      });
      if (!current) throw new AppError(404, "Product not found");

      const product = await prisma.product.update({
        where: { id: current.id },
        data: { ...toProductPatch(data), updatedAt: new Date() },
      });
      res.json({ data: product });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("products.update"),
  async (req: AuthRequest, res, next) => {
    try {
      // Same rule as the update: only ever touch a product in the caller's organization.
      const current = await prisma.product.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        select: {
          id: true,
          _count: { select: { invoiceItems: true, purchaseItems: true, inventories: true } },
        },
      });
      if (!current) throw new AppError(404, "Product not found");
      if (current._count.invoiceItems > 0) {
        throw new AppError(
          409,
          "This product appears on an invoice, so it cannot be deleted",
          "PRODUCT_IN_USE"
        );
      }

      await prisma.product.delete({ where: { id: current.id } });
      res.json({ data: { id: current.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);
