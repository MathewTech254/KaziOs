import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

export const settingsRouter = Router();

settingsRouter.get("/", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.setting.findMany({ where: { organizationId: req.organizationId } });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

settingsRouter.put("/:key", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const setting = await prisma.setting.upsert({
      where: { organizationId_key: { organizationId: req.organizationId!, key: req.params.key } },
      update: { value: req.body },
      create: { organizationId: req.organizationId!, key: req.params.key, value: req.body },
    });
    res.json({ data: setting });
  } catch (err) {
    next(err);
  }
});