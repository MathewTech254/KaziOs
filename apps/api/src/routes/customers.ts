import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zCustomerSchema } from "@kazios/validation";

export const customerRouter = Router();

/** Empty optional fields from a form are stored as null rather than blank strings. */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed.length ? trimmed : null;
}

/** PATCH sends only the fields the user changed, so absent keys must stay absent. */
function toCustomerPatch(input: Partial<z.infer<typeof zCustomerSchema>>) {
  const data: Record<string, string | null> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.email !== undefined) data.email = optionalText(input.email);
  if (input.phone !== undefined) data.phone = optionalText(input.phone);
  if (input.address !== undefined) data.address = optionalText(input.address);
  if (input.taxNumber !== undefined) data.taxNumber = optionalText(input.taxNumber);
  return data;
}

customerRouter.get("/", requireAuth, requirePermission("customers.view"), async (req: AuthRequest, res, next) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
    const where: any = { organizationId: req.organizationId };
    if (search) where.name = { contains: String(search), mode: "insensitive" };
    const [data, total] = await Promise.all([
      prisma.customer.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.customer.count({ where }),
    ]);
    res.json({ data, total, page: p, limit: l, totalPages: Math.ceil(total / l) });
  } catch (err) {
    next(err);
  }
});

customerRouter.post("/", requireAuth, requirePermission("customers.create"), async (req: AuthRequest, res, next) => {
  try {
    const data = zCustomerSchema.parse(req.body);
    const customer = await prisma.customer.create({
      data: { ...data, organizationId: req.organizationId!, email: data.email || undefined, phone: data.phone || undefined, address: data.address || undefined, taxNumber: data.taxNumber || undefined },
    });
    res.status(201).json({ data: customer });
  } catch (err) {
    next(err);
  }
});

customerRouter.patch("/:id", requireAuth, requirePermission("customers.update"), async (req: AuthRequest, res, next) => {
  try {
    const data = zCustomerSchema.partial().parse(req.body);
    // Resolve inside the caller's organization first. Updating by bare id let one tenant
    // edit another tenant's customer, and the old code also reassigned organizationId,
    // which silently handed the whole record over to the attacker.
    const current = await prisma.customer.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true },
    });
    if (!current) throw new AppError(404, "Customer not found");

    const customer = await prisma.customer.update({
      where: { id: current.id },
      data: { ...toCustomerPatch(data), updatedAt: new Date() },
    });
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

customerRouter.delete("/:id", requireAuth, requirePermission("customers.update"), async (req: AuthRequest, res, next) => {
  try {
    // Same rule as the update: the record has to belong to the caller's organization.
    const current = await prisma.customer.findFirst({
      where: { id: req.params.id, organizationId: req.organizationId! },
      select: { id: true, _count: { select: { invoices: true, payments: true } } },
    });
    if (!current) throw new AppError(404, "Customer not found");
    if (current._count.invoices > 0 || current._count.payments > 0) {
      throw new AppError(
        409,
        "This customer has invoices or payments against it, so it cannot be deleted. Deactivate them instead.",
        "CUSTOMER_IN_USE"
      );
    }

    await prisma.customer.delete({ where: { id: current.id } });
    res.json({ data: { id: current.id, deleted: true } });
  } catch (err) {
    next(err);
  }
});

customerRouter.get("/:id", requireAuth, requirePermission("customers.view"), async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
      include: { invoices: { take: 10, orderBy: { createdAt: "desc" } }, payments: { take: 10, orderBy: { createdAt: "desc" } } },
    });
    if (!customer) throw new AppError(404, "Customer not found");
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});