import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import {
  zBranchSchema,
  zBranchUpdateSchema,
  zOrganizationUpdateSchema,
  zWarehouseSchema,
  zWarehouseUpdateSchema,
} from "@kazios/validation";
import { FEATURE_KEYS, LIMIT_KEYS } from "@kazios/types";
import { assertFeature, assertWithinLimit, getEntitlements } from "../services/entitlements";

export const organizationRouter = Router();

organizationRouter.get("/", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.organizationId },
      include: { branches: true, warehouses: true, roles: true },
    });
    if (!org) throw new AppError(404, "Organization not found");
    res.json({ data: org });
  } catch (err) {
    next(err);
  }
});

organizationRouter.patch(
  "/",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zOrganizationUpdateSchema.parse(req.body);
      const org = await prisma.organization.update({
        where: { id: req.organizationId },
        data: { ...data, updatedAt: new Date() },
      });
      res.json({ data: org });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.get("/branches", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.branch.findMany({
      where: { organizationId: req.organizationId },
      include: { warehouses: true },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

organizationRouter.post(
  "/branches",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zBranchSchema.parse(req.body);
      const entitlements = await getEntitlements(req.organizationId!);

      // Two checks, in this order, and both before anything is written.
      //
      // The feature check asks whether a second location is part of the plan at all; the
      // limit check asks how many this plan allows. They answer different questions and a
      // business on a plan with three branches must not be refused a fourth with a message
      // about not having the capability at all.
      //
      // Neither check is in the browser. Hiding the button stops an honest user; this stops
      // everybody else.
      await assertFeature(entitlements, FEATURE_KEYS.MULTI_BRANCH, {
        featureName: "Multiple branches",
      });
      await assertWithinLimit(entitlements, LIMIT_KEYS.BRANCHES, {
        featureKey: FEATURE_KEYS.MULTI_BRANCH,
      });

      const branch = await prisma.$transaction(async (tx: any) => {
        if (data.isMain) {
          await tx.branch.updateMany({
            where: { organizationId: req.organizationId },
            data: { isMain: false },
          });
        }
        return tx.branch.create({
          data: {
            name: data.name,
            code: data.code,
            address: data.address || null,
            phone: data.phone || null,
            isMain: data.isMain ?? false,
            organizationId: req.organizationId!,
          },
        });
      });
      res.status(201).json({ data: branch });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.patch(
  "/branches/:id",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zBranchUpdateSchema.parse(req.body);
      const branch = await prisma.branch.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
      });
      if (!branch) throw new AppError(404, "Branch not found");

      if (data.code && data.code !== branch.code) {
        const clash = await prisma.branch.findFirst({
          where: { organizationId: req.organizationId, code: data.code },
        });
        if (clash)
          throw new AppError(
            409,
            `A branch with code "${data.code}" already exists`,
            "BRANCH_EXISTS"
          );
      }

      const updated = await prisma.$transaction(async (tx: any) => {
        if (data.isMain) {
          await tx.branch.updateMany({
            where: { organizationId: req.organizationId, NOT: { id: branch.id } },
            data: { isMain: false },
          });
        }
        return tx.branch.update({ where: { id: branch.id }, data });
      });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.delete(
  "/branches/:id",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const branch = await prisma.branch.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
        include: {
          _count: {
            select: {
              warehouses: true,
              users: true,
              invoices: true,
              payments: true,
              orders: true,
              purchases: true,
              expenses: true,
              quotations: true,
              stockMovements: true,
            },
          },
        },
      });
      if (!branch) throw new AppError(404, "Branch not found");
      if (branch.isMain)
        throw new AppError(409, "The main branch cannot be deleted", "MAIN_BRANCH");

      const inUse = Object.values(branch._count).reduce((sum, count) => sum + count, 0);
      if (inUse > 0) {
        throw new AppError(
          409,
          "Branch has related records and cannot be deleted",
          "BRANCH_IN_USE"
        );
      }

      await prisma.branch.delete({ where: { id: branch.id } });
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.get("/warehouses", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.warehouse.findMany({
      where: { organizationId: req.organizationId },
      include: { branch: true },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

organizationRouter.post(
  "/warehouses",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zWarehouseSchema.parse(req.body);

      if (data.branchId) {
        const branch = await prisma.branch.findFirst({
          where: { id: data.branchId, organizationId: req.organizationId },
        });
        if (!branch) throw new AppError(404, "Branch not found");
      }

      const warehouse = await prisma.warehouse.create({
        data: {
          name: data.name,
          code: data.code,
          address: data.address || null,
          branchId: data.branchId || undefined,
          organizationId: req.organizationId!,
        },
      });
      res.status(201).json({ data: warehouse });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.patch(
  "/warehouses/:id",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = zWarehouseUpdateSchema.parse(req.body);
      const warehouse = await prisma.warehouse.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
      });
      if (!warehouse) throw new AppError(404, "Warehouse not found");

      if (data.code && data.code !== warehouse.code) {
        const clash = await prisma.warehouse.findFirst({
          where: { organizationId: req.organizationId, code: data.code },
        });
        if (clash)
          throw new AppError(
            409,
            `A warehouse with code "${data.code}" already exists`,
            "WAREHOUSE_EXISTS"
          );
      }

      if (data.branchId) {
        const branch = await prisma.branch.findFirst({
          where: { id: data.branchId, organizationId: req.organizationId },
        });
        if (!branch) throw new AppError(404, "Branch not found");
      }

      const updated = await prisma.warehouse.update({ where: { id: warehouse.id }, data });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

organizationRouter.delete(
  "/warehouses/:id",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const warehouse = await prisma.warehouse.findFirst({
        where: { id: req.params.id, organizationId: req.organizationId },
        include: {
          _count: {
            select: {
              inventories: true,
              stockMovements: true,
              sourceTransfers: true,
              destTransfers: true,
              userRoles: true,
            },
          },
        },
      });
      if (!warehouse) throw new AppError(404, "Warehouse not found");

      const inUse = Object.values(warehouse._count).reduce((sum, count) => sum + count, 0);
      if (inUse > 0) {
        throw new AppError(
          409,
          "Warehouse has related records and cannot be deleted",
          "WAREHOUSE_IN_USE"
        );
      }

      await prisma.warehouse.delete({ where: { id: warehouse.id } });
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);
