import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import { zTaxCategorySchema, zTaxCategoryUpdateSchema } from "@kazios/validation";

export const taxCategoryRouter = Router();

const duplicateName = (name: string) => `A tax category named "${name}" already exists`;

async function findTaxCategory(organizationId: string | undefined, id: string) {
  const category = await prisma.taxCategory.findFirst({ where: { id, organizationId } });
  if (!category) throw new AppError(404, "Tax category not found");
  return category;
}

taxCategoryRouter.get("/", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.taxCategory.findMany({
      where: { organizationId: req.organizationId },
      include: { _count: { select: { products: true, invoiceItems: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

taxCategoryRouter.post("/", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const body = zTaxCategorySchema.parse(req.body);
    const existing = await prisma.taxCategory.findFirst({
      where: { organizationId: req.organizationId, name: body.name },
    });
    if (existing) throw new AppError(409, duplicateName(body.name), "TAX_CATEGORY_EXISTS");

    const category = await prisma.taxCategory.create({
      data: { ...body, organizationId: req.organizationId! },
    });
    res.status(201).json({ data: category });
  } catch (err) {
    next(err);
  }
});

taxCategoryRouter.patch("/:id", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const body = zTaxCategoryUpdateSchema.parse(req.body);
    const current = await findTaxCategory(req.organizationId, req.params.id);

    if (body.name && body.name !== current.name) {
      const clash = await prisma.taxCategory.findFirst({
        where: { organizationId: req.organizationId, name: body.name },
      });
      if (clash) throw new AppError(409, duplicateName(body.name), "TAX_CATEGORY_EXISTS");
    }

    const category = await prisma.taxCategory.update({ where: { id: current.id }, data: body });
    res.json({ data: category });
  } catch (err) {
    next(err);
  }
});

taxCategoryRouter.delete("/:id", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const current = await prisma.taxCategory.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId },
      include: { _count: { select: { products: true, invoiceItems: true } } },
    });
    if (!current) throw new AppError(404, "Tax category not found");

    if (current._count.products + current._count.invoiceItems > 0) {
      throw new AppError(
        409,
        "Tax category is assigned to products or invoice lines and cannot be deleted",
        "TAX_CATEGORY_IN_USE"
      );
    }

    await prisma.taxCategory.delete({ where: { id: current.id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});
