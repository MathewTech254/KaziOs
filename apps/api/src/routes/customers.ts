import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { AppError, paginate } from "../lib";
import { zCustomerSchema } from "@kazios/validation";

export const customerRouter = Router();

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
    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: { ...data, organizationId: req.organizationId, updatedAt: new Date() },
    });
    res.json({ data: customer });
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