import { Router } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "../middleware/auth";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../lib";
import { PERMISSION_GROUPS, PERMISSIONS, zRoleSchema, zRoleUpdateSchema } from "@kazios/validation";

export const roleRouter = Router();

async function findRole(organizationId: string | undefined, id: string) {
  const role = await prisma.role.findFirst({
    where: { id, organizationId },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw new AppError(404, "Role not found");
  return role;
}

roleRouter.get(
  "/permissions",
  requireAuth,
  requirePermission("users.view"),
  async (_req: AuthRequest, res, next) => {
    try {
      res.json({ data: PERMISSION_GROUPS, permissions: PERMISSIONS });
    } catch (err) {
      next(err);
    }
  }
);

roleRouter.get(
  "/",
  requireAuth,
  requirePermission("users.view"),
  async (req: AuthRequest, res, next) => {
    try {
      const data = await prisma.role.findMany({
        where: { organizationId: req.organizationId },
        include: { _count: { select: { users: true } } },
        orderBy: { createdAt: "asc" },
      });
      res.json({ data, total: data.length });
    } catch (err) {
      next(err);
    }
  }
);

roleRouter.post(
  "/",
  requireAuth,
  requirePermission("users.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const body = zRoleSchema.parse(req.body);
      if (body.type.toUpperCase() === "OWNER") {
        throw new AppError(
          409,
          "The OWNER role is reserved and cannot be created",
          "ROLE_TYPE_RESERVED"
        );
      }

      const existing = await prisma.role.findFirst({
        where: { organizationId: req.organizationId, name: body.name },
      });
      if (existing)
        throw new AppError(409, `A role named "${body.name}" already exists`, "ROLE_EXISTS");

      const role = await prisma.role.create({
        data: { ...body, type: body.type.toUpperCase(), organizationId: req.organizationId! },
      });
      res.status(201).json({ data: role });
    } catch (err) {
      next(err);
    }
  }
);

roleRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("users.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const body = zRoleUpdateSchema.parse(req.body);
      const role = await findRole(req.organizationId, req.params.id);
      if (role.type === "OWNER") {
        throw new AppError(409, "The OWNER role cannot be modified", "ROLE_TYPE_RESERVED");
      }

      if (body.name && body.name !== role.name) {
        const clash = await prisma.role.findFirst({
          where: { organizationId: req.organizationId, name: body.name },
        });
        if (clash)
          throw new AppError(409, `A role named "${body.name}" already exists`, "ROLE_EXISTS");
      }

      const updated = await prisma.role.update({
        where: { id: role.id },
        data: {
          name: body.name,
          description: body.description,
          permissions: body.permissions,
          type: body.type ? body.type.toUpperCase() : undefined,
        },
      });
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

roleRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("users.manage"),
  async (req: AuthRequest, res, next) => {
    try {
      const role = await findRole(req.organizationId, req.params.id);
      if (role.type === "OWNER") {
        throw new AppError(409, "The OWNER role cannot be deleted", "ROLE_TYPE_RESERVED");
      }
      if (role._count.users > 0) {
        throw new AppError(409, "Role is assigned to users and cannot be deleted", "ROLE_IN_USE");
      }

      await prisma.role.delete({ where: { id: role.id } });
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);
