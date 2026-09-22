import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zProductSchema } from "@kazios/validation";

export const productRouter = Router();

productRouter.get("/", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const { page = 1, limit = 50, search, productType } = req.query;
    const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
    const where: any = { organizationId: req.organizationId };
    if (search) where.name = { contains: String(search), mode: "insensitive" };
    if (productType) where.productType = String(productType);

    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, include: { taxCategory: true, brand: true, unit: true }, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.product.count({ where }),
    ]);
    res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
  } catch (err) {
    next(err);
  }
});

productRouter.post("/", requireAuth, requirePermission("products.create"), async (req: AuthRequest, res, next) => {
  try {
    const data = zProductSchema.parse(req.body);
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
});

productRouter.get("/:id", requireAuth, requirePermission("products.view"), async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
      include: { taxCategory: true, brand: true, unit: true, inventories: { include: { warehouse: true } } },
    });
    if (!product) throw new AppError(404, "Product not found");
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
});

productRouter.patch("/:id", requireAuth, requirePermission("products.update"), async (req: AuthRequest, res, next) => {
  try {
    const data = zProductSchema.partial().parse(req.body);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { ...data, organizationId: req.organizationId, updatedAt: new Date() },
    });
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
});

productRouter.delete("/:id", requireAuth, requirePermission("products.update"), async (req, res, next) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});