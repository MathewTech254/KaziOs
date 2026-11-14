import { Router } from "express";
import type { z } from "zod";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zProductSchema, zProductUnitSchema, zProductUnitQuerySchema } from "@kazios/validation";
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

const productInclude = {
  taxCategory: true,
  brand: true,
  unit: true,
  productUnits: true,
  inventories: { include: { warehouse: true } },
};

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
          include: { taxCategory: true, brand: true, unit: true, productUnits: true },
          skip,
          take,
          orderBy: { createdAt: "desc" },
        }),
        prisma.product.count({ where }),
      ]);
      // Attendants must not see cost prices — strip costPrice unless the caller is an owner.
      const isOwner = req.roles?.some((r: any) => r.role.permissions.includes("*")) ?? false;
      const safeData = isOwner ? data : data.map(({ costPrice, ...rest }) => rest);
      res.json({ data: safeData, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
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
          size: data.size || undefined,
          category: data.category || undefined,
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
  async (req: AuthRequest, res, next) => {
    try {
      const product = await prisma.product.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
        include: productInclude,
      });
      if (!product) throw new AppError(404, "Product not found");
      // Attendants must not see cost prices.
      const isOwner = req.roles?.some((r: any) => r.role.permissions.includes("*")) ?? false;
      if (isOwner) {
        res.json({ data: product });
      } else {
        const { costPrice: _cp, ...safeProduct } = product;
        res.json({ data: safeProduct });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Import products from CSV. Accepts CSV text in the request body with columns:
 * name,sku,barcode,size,category,costPrice,sellingPrice,minStock,reorderPoint
 * Only name and sellingPrice are required. costPrice defaults to sellingPrice.
 */
productRouter.post(
  "/import",
  requireAuth,
  requirePermission("products.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;

      // The catalogue is a counted allowance.
      const entitlements = await getEntitlements(organizationId);
      await assertWithinLimit(entitlements, LIMIT_KEYS.PRODUCTS);

      const csvText = typeof req.body === "string" ? req.body : req.body.csv || "";
      if (!csvText.trim()) {
        throw new AppError(400, "CSV body is required", "CSV_BODY_REQUIRED");
      }

      const lines = csvText.trim().split(/\r?\n/);
      if (lines.length < 2) {
        throw new AppError(
          400,
          "CSV must have a header row and at least one data row",
          "CSV_INVALID"
        );
      }

      const header = lines[0].split(",").map((h: string) => h.trim().toLowerCase());
      const colIndex = (name: string) => header.indexOf(name);

      const results = [];
      const errors = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(",");
        const get = (name: string) => {
          const idx = colIndex(name);
          return idx >= 0 ? cols[idx]?.trim() : undefined;
        };

        const name = get("name");
        if (!name) {
          errors.push({ row: i + 1, error: "name is required" });
          continue;
        }

        const sellingPriceRaw = get("sellingprice") || get("selling_price") || get("price");
        const sellingPrice = sellingPriceRaw ? parseFloat(sellingPriceRaw) : undefined;
        if (!sellingPrice || isNaN(sellingPrice) || sellingPrice <= 0) {
          errors.push({ row: i + 1, error: "sellingPrice must be a positive number" });
          continue;
        }

        const costPriceRaw = get("costprice") || get("cost_price");
        const costPrice = costPriceRaw ? parseFloat(costPriceRaw) : sellingPrice;

        const minStockRaw = get("minstock") || get("min_stock");
        const minStock = minStockRaw ? parseInt(minStockRaw, 10) : 0;

        const reorderPointRaw = get("reorderpoint") || get("reorder_point");
        const reorderPoint = reorderPointRaw ? parseInt(reorderPointRaw, 10) : 0;

        const sku = get("sku") || undefined;
        const barcode = get("barcode") || undefined;
        const size = get("size") || undefined;
        const category = get("category") || undefined;

        const existingSku = sku
          ? await prisma.product.findFirst({ where: { organizationId, sku } })
          : null;
        if (existingSku) {
          errors.push({ row: i + 1, error: `SKU "${sku}" already exists` });
          continue;
        }

        const product = await prisma.product.create({
          data: {
            name,
            sku,
            barcode,
            size,
            category,
            costPrice,
            sellingPrice,
            minStock: isNaN(minStock) ? 0 : minStock,
            reorderPoint: isNaN(reorderPoint) ? 0 : reorderPoint,
            isActive: true,
            productType: "PHYSICAL",
            organizationId,
          },
        });
        results.push(product);
      }

      res.status(201).json({
        data: results,
        imported: results.length,
        errors,
        total: results.length + errors.length,
      });
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

/**
 * Product unit (pack unit) endpoints.
 *
 * A product has a base sellable unit (bottle/can) and optional pack units (crate, carton,
 * case) with a conversion factor (e.g. 1 crate = 24 bottles). Receiving stock in crates
 * converts to base units in the ledger.
 */
productRouter.get(
  "/:productId/units",
  requireAuth,
  requirePermission("products.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const parsed = zProductUnitQuerySchema.safeParse({
        ...req.query,
        productId: req.params.productId,
      });
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid query");
      }
      const { page, limit } = parsed.data;
      const { skip, take, page: p, limit: l } = paginate(page, limit);
      const organizationId = req.organizationId!;

      const [data, total] = await Promise.all([
        prisma.productUnit.findMany({
          where: { productId: req.params.productId, organizationId },
          skip,
          take,
          orderBy: { isDefaultSaleUnit: "desc", name: "asc" },
        }),
        prisma.productUnit.count({
          where: { productId: req.params.productId, organizationId },
        }),
      ]);
      res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.post(
  "/:productId/units",
  requireAuth,
  requirePermission("products.update"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zProductUnitSchema.parse(req.body);
      const organizationId = req.organizationId!;

      // Verify the product belongs to this organization.
      const product = await prisma.product.findFirst({
        where: { id: req.params.productId, organizationId },
        select: { id: true },
      });
      if (!product) throw new AppError(404, "Product not found");

      // Only one default sale unit and one default purchase unit per product.
      if (data.isDefaultSaleUnit) {
        await prisma.productUnit.updateMany({
          where: { productId: req.params.productId, isDefaultSaleUnit: true },
          data: { isDefaultSaleUnit: false },
        });
      }
      if (data.isDefaultPurchaseUnit) {
        await prisma.productUnit.updateMany({
          where: { productId: req.params.productId, isDefaultPurchaseUnit: true },
          data: { isDefaultPurchaseUnit: false },
        });
      }

      const unit = await prisma.productUnit.create({
        data: {
          name: data.name,
          factorToBase: data.factorToBase,
          isDefaultSaleUnit: data.isDefaultSaleUnit,
          isDefaultPurchaseUnit: data.isDefaultPurchaseUnit,
          productId: req.params.productId,
          organizationId,
        },
      });
      res.status(201).json({ data: unit });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.patch(
  "/:productId/units/:unitId",
  requireAuth,
  requirePermission("products.update"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zProductUnitSchema.partial().parse(req.body);
      const organizationId = req.organizationId!;

      const unit = await prisma.productUnit.findFirst({
        where: {
          id: req.params.unitId,
          productId: req.params.productId,
          organizationId,
        },
        select: { id: true },
      });
      if (!unit) throw new AppError(404, "Product unit not found");

      if (data.isDefaultSaleUnit) {
        await prisma.productUnit.updateMany({
          where: { productId: req.params.productId, isDefaultSaleUnit: true },
          data: { isDefaultSaleUnit: false },
        });
      }
      if (data.isDefaultPurchaseUnit) {
        await prisma.productUnit.updateMany({
          where: { productId: req.params.productId, isDefaultPurchaseUnit: true },
          data: { isDefaultPurchaseUnit: false },
        });
      }

      const updated = await prisma.productUnit.update({
        where: { id: unit.id },
        data,
      });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

productRouter.delete(
  "/:productId/units/:unitId",
  requireAuth,
  requirePermission("products.update"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;

      const unit = await prisma.productUnit.findFirst({
        where: {
          id: req.params.unitId,
          productId: req.params.productId,
          organizationId,
        },
        select: { id: true, isDefaultSaleUnit: true, isDefaultPurchaseUnit: true },
      });
      if (!unit) throw new AppError(404, "Product unit not found");

      await prisma.productUnit.delete({ where: { id: unit.id } });
      res.json({ data: { id: unit.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);
