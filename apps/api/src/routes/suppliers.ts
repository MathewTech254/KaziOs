import { Router } from "express";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zSupplierQuerySchema, zSupplierSchema } from "@kazios/validation";

export const supplierRouter = Router();

/** Empty optional fields from a form are stored as null rather than blank strings. */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed.length ? trimmed : null;
}

function toSupplierData(input: z.infer<typeof zSupplierSchema>) {
  return {
    name: input.name.trim(),
    email: optionalText(input.email),
    phone: optionalText(input.phone),
    address: optionalText(input.address),
    taxNumber: optionalText(input.taxNumber),
  };
}

/** PATCH sends only the fields the user changed, so absent keys must stay absent. */
function toSupplierPatch(input: Partial<z.infer<typeof zSupplierSchema>>) {
  const data: Record<string, string | null> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.email !== undefined) data.email = optionalText(input.email);
  if (input.phone !== undefined) data.phone = optionalText(input.phone);
  if (input.address !== undefined) data.address = optionalText(input.address);
  if (input.taxNumber !== undefined) data.taxNumber = optionalText(input.taxNumber);
  return data;
}

supplierRouter.get(
  "/",
  requireAuth,
  requirePermission("purchasing.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const organizationId = req.organizationId!;
      const query = zSupplierQuerySchema.parse(req.query);
      const { skip, take, page, limit } = paginate(query.page, query.limit);

      const where: Prisma.SupplierWhereInput = { organizationId };
      if (query.search) {
        const term = query.search.trim();
        where.OR = [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { phone: { contains: term, mode: "insensitive" } },
          { taxNumber: { contains: term, mode: "insensitive" } },
        ];
      }

      const [data, total] = await Promise.all([
        prisma.supplier.findMany({
          where,
          skip,
          take,
          orderBy: { name: "asc" },
          include: { _count: { select: { purchaseOrders: true } } },
        }),
        prisma.supplier.count({ where }),
      ]);

      res.json({ data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (err) {
      next(err);
    }
  }
);

supplierRouter.get(
  "/:id",
  requireAuth,
  requirePermission("purchasing.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const supplier = await prisma.supplier.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        include: {
          purchaseOrders: {
            take: 10,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              poNumber: true,
              status: true,
              totalAmount: true,
              expectedDate: true,
              createdAt: true,
            },
          },
          _count: { select: { purchaseOrders: true } },
        },
      });
      if (!supplier) throw new AppError(404, "Supplier not found");
      res.json({ data: supplier });
    } catch (err) {
      next(err);
    }
  }
);

supplierRouter.post(
  "/",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const input = zSupplierSchema.parse(req.body);
      const data = toSupplierData(input);

      const existing = await prisma.supplier.findFirst({
        where: { organizationId: req.organizationId!, name: data.name },
        select: { id: true },
      });
      if (existing)
        throw new AppError(
          409,
          `A supplier named "${data.name}" already exists`,
          "SUPPLIER_EXISTS"
        );

      const supplier = await prisma.supplier.create({
        data: { ...data, organizationId: req.organizationId! },
      });
      res.status(201).json({ data: supplier });
    } catch (err) {
      next(err);
    }
  }
);

supplierRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const input = zSupplierSchema.partial().parse(req.body);
      const current = await prisma.supplier.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        select: { id: true },
      });
      if (!current) throw new AppError(404, "Supplier not found");

      const supplier = await prisma.supplier.update({
        where: { id: current.id },
        data: toSupplierPatch(input),
      });
      res.json({ data: supplier });
    } catch (err) {
      next(err);
    }
  }
);

supplierRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("purchasing.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const supplier = await prisma.supplier.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId! },
        include: { _count: { select: { purchaseOrders: true, expenses: true } } },
      });
      if (!supplier) throw new AppError(404, "Supplier not found");
      if (supplier._count.purchaseOrders > 0) {
        throw new AppError(
          409,
          "This supplier has purchase orders, so it cannot be deleted",
          "SUPPLIER_IN_USE"
        );
      }
      if (supplier._count.expenses > 0) {
        throw new AppError(
          409,
          "This supplier has recorded expenses, so it cannot be deleted",
          "SUPPLIER_IN_USE"
        );
      }

      await prisma.supplier.delete({ where: { id: supplier.id } });
      res.json({ data: { id: supplier.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  }
);
