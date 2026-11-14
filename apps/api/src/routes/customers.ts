import { Router } from "express";
import type { z } from "zod";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
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

customerRouter.get(
  "/",
  requireAuth,
  requirePermission("customers.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const { page = 1, limit = 50, search } = req.query;
      const { skip, take, page: p, limit: l } = paginate(Number(page), Number(limit));
      const where: any = { organizationId: req.organizationId };

      if (search) {
        // Name, phone and email together, because the three are how a person is actually
        // looked up. A cashier at a till is usually given a phone number, not a surname,
        // and searching the name alone meant the commonest lookup of the day returned
        // nothing. The term is a contains match so a partial number still finds them.
        const term = String(search).trim();
        where.OR = [
          { name: { contains: term, mode: "insensitive" } },
          { phone: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
        ];
      }

      const [data, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: "desc" },
          include: {
            _count: {
              select: {
                invoices: {
                  where: { status: { not: "VOID" } },
                },
              },
            },
            invoices: {
              where: { status: { not: "VOID" } },
              select: { total: true, paidAmount: true, createdAt: true },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
        prisma.customer.count({ where }),
      ]);

      // Balance owed = unpaid invoice totals − standalone customer repayments.
      // Last purchase date = most recent non-void invoice date.
      const customersWithBalance = data.map(customer => {
        const invoices = customer.invoices as {
          total: number;
          paidAmount: number;
          createdAt: Date;
        }[];
        const owed = invoices.reduce(
          (sum, inv) => sum + Number(inv.total) - Number(inv.paidAmount),
          0
        );
        const balanceOwed = Math.max(0, owed);
        const lastPurchase = invoices.length ? invoices[0].createdAt : null;
        const { invoices: _, _count: __, ...rest } = customer;
        return {
          ...rest,
          balanceOwed,
          lastPurchaseDate: lastPurchase,
          creditLimit: rest.creditLimit,
        };
      });

      res.json({
        data: customersWithBalance,
        total,
        page: p,
        limit: l,
        totalPages: Math.ceil(total / l),
      });
    } catch (err) {
      next(err);
    }
  }
);

customerRouter.post(
  "/",
  requireAuth,
  requirePermission("customers.create"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zCustomerSchema.parse(req.body);
      const customer = await prisma.customer.create({
        data: {
          ...data,
          organizationId: req.organizationId!,
          email: data.email || undefined,
          phone: data.phone || undefined,
          address: data.address || undefined,
          taxNumber: data.taxNumber || undefined,
        },
      });
      res.status(201).json({ data: customer });
    } catch (err) {
      next(err);
    }
  }
);

customerRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("customers.update"),
  async (req: AuthRequest, res, next) => {
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
  }
);

customerRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("customers.update"),
  async (req: AuthRequest, res, next) => {
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
  }
);

customerRouter.get(
  "/:id",
  requireAuth,
  requirePermission("customers.view"),
  async (req, res, next) => {
    try {
      const customer = await prisma.customer.findFirst({
        where: { id: req.params.id, organizationId: (req as AuthRequest).organizationId },
        include: {
          invoices: {
            where: { status: { not: "VOID" } },
            select: { total: true, paidAmount: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
          payments: {
            where: { provider: "CREDIT", invoiceId: null, status: "SUCCESS" },
            select: { amount: true },
          },
        },
      });
      if (!customer) throw new AppError(404, "Customer not found");
      const owed = customer.invoices.reduce(
        (sum, inv) => sum + Number(inv.total) - Number(inv.paidAmount),
        0
      );
      const repaid = customer.payments.reduce((sum, p) => sum + Number(p.amount), 0);
      const { invoices: _, payments: __, ...rest } = customer;
      res.json({
        data: {
          ...rest,
          balanceOwed: Math.max(0, owed - repaid),
          lastPurchaseDate:
            customer.invoices.length > 0
              ? (customer.invoices[0] as { createdAt: Date }).createdAt
              : null,
          creditLimit: rest.creditLimit,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
