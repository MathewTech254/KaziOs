import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import {
  SETTING_KEYS,
  allSettingDefaults,
  isSettingKey,
  parseSettingValue,
  settingDefaults,
} from "@kazios/validation";

export const settingsRouter = Router();

settingsRouter.get(
  "/",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const rows = await prisma.setting.findMany({ where: { organizationId: req.organizationId } });
      const values: Record<string, Record<string, unknown>> = allSettingDefaults();

      for (const row of rows) {
        if (!isSettingKey(row.key)) continue;
        const stored =
          row.value && typeof row.value === "object" && !Array.isArray(row.value)
            ? (row.value as Record<string, unknown>)
            : {};
        values[row.key] = { ...settingDefaults(row.key), ...stored };
      }

      res.json({ data: values, keys: SETTING_KEYS });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.put(
  "/:key",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const key = req.params.key;
      if (!isSettingKey(key)) {
        throw new AppError(400, `Unknown setting key "${key}"`, "UNKNOWN_SETTING_KEY");
      }
      const value = parseSettingValue(key, req.body);

      const setting = await prisma.setting.upsert({
        where: { organizationId_key: { organizationId: req.organizationId!, key } },
        update: { value: value as Prisma.InputJsonValue },
        create: { organizationId: req.organizationId!, key, value: value as Prisma.InputJsonValue },
      });
      res.json({ data: { key, value: setting.value } });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.delete(
  "/:key",
  requireAuth,
  requirePermission("settings.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const key = req.params.key;
      if (!isSettingKey(key)) {
        throw new AppError(400, `Unknown setting key "${key}"`, "UNKNOWN_SETTING_KEY");
      }

      await prisma.setting.deleteMany({ where: { organizationId: req.organizationId, key } });
      res.json({ data: { key, value: settingDefaults(key) } });
    } catch (err) {
      next(err);
    }
  }
);
