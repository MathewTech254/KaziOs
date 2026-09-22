import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { AppError } from "../lib";

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

organizationRouter.patch("/", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { name, address, phone, email, taxNumber, businessCategory, currency, timezone, language } = req.body;
    const org = await prisma.organization.update({
      where: { id: req.organizationId },
      data: { name, address, phone, email, taxNumber, businessCategory, currency, timezone, language, updatedAt: new Date() },
    });
    res.json({ data: org });
  } catch (err) {
    next(err);
  }
});

organizationRouter.get("/branches", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.branch.findMany({ where: { organizationId: req.organizationId }, include: { warehouses: true } });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

organizationRouter.post("/branches", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { name, code, address, phone } = req.body;
    const branch = await prisma.branch.create({
      data: { name, code, address, phone, organizationId: req.organizationId! },
    });
    res.status(201).json({ data: branch });
  } catch (err) {
    next(err);
  }
});

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

organizationRouter.post("/warehouses", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { name, code, address, branchId } = req.body;
    const warehouse = await prisma.warehouse.create({
      data: { name, code, address, organizationId: req.organizationId!, branchId: branchId || undefined },
    });
    res.status(201).json({ data: warehouse });
  } catch (err) {
    next(err);
  }
});