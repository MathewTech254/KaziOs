import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AppError, hashPassword } from "../lib";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { zUserCreateSchema, zUserRoleAssignSchema } from "@kazios/validation";

export const userRouter = Router();

const userSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  status: true,
  createdAt: true,
  roles: {
    select: {
      id: true,
      branchId: true,
      warehouseId: true,
      role: { select: { id: true, name: true, type: true, permissions: true } },
    },
  },
} as const;

async function findMember(organizationId: string | undefined, id: string) {
  const user = await prisma.user.findFirst({ where: { id, organizationId } });
  if (!user) throw new AppError(404, "User not found");
  return user;
}

userRouter.get("/", requireAuth, requirePermission("users.view"), async (req: AuthRequest, res, next) => {
  try {
    const data = await prisma.user.findMany({
      where: { organizationId: req.organizationId },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });
    res.json({ data, total: data.length });
  } catch (err) {
    next(err);
  }
});

userRouter.post("/", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res, next) => {
  try {
    const body = zUserCreateSchema.parse(req.body);
    const email = body.email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError(409, "Email already registered", "EMAIL_EXISTS");

    const role = body.roleId
      ? await prisma.role.findFirst({ where: { id: body.roleId, organizationId: req.organizationId } })
      : null;
    if (body.roleId && !role) throw new AppError(404, "Role not found");

    const passwordHash = await hashPassword(body.password);

    const user = await prisma.$transaction(async (tx: any) => {
      const created = await tx.user.create({
        data: {
          email,
          name: body.name,
          passwordHash,
          organizationId: req.organizationId!,
          status: "ACTIVE",
        },
      });

      if (role) {
        await tx.userRole.create({
          data: {
            userId: created.id,
            roleId: role.id,
            branchId: body.branchId || undefined,
            warehouseId: body.warehouseId || undefined,
          },
        });
      }

      return tx.user.findUnique({ where: { id: created.id }, select: userSelect });
    });

    res.status(201).json({ data: user });
  } catch (err) {
    next(err);
  }
});

userRouter.post("/:id/roles", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res, next) => {
  try {
    const body = zUserRoleAssignSchema.parse(req.body);
    const user = await findMember(req.organizationId, req.params.id);

    const role = await prisma.role.findFirst({
      where: { id: body.roleId, organizationId: req.organizationId },
    });
    if (!role) throw new AppError(404, "Role not found");

    const existing = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id, branchId: body.branchId || null },
    });
    if (existing) throw new AppError(409, "This role is already assigned to the user", "USER_ROLE_EXISTS");

    const assignment = await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
        branchId: body.branchId || undefined,
        warehouseId: body.warehouseId || undefined,
      },
      include: { role: { select: { id: true, name: true, type: true, permissions: true } } },
    });
    res.status(201).json({ data: assignment });
  } catch (err) {
    next(err);
  }
});

userRouter.delete("/:id/roles/:userRoleId", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res, next) => {
  try {
    const user = await findMember(req.organizationId, req.params.id);

    const assignment = await prisma.userRole.findFirst({
      where: { id: req.params.userRoleId, userId: user.id },
      include: { role: true },
    });
    if (!assignment) throw new AppError(404, "Role assignment not found");

    if (assignment.role.type === "OWNER") {
      const owners = await prisma.userRole.count({ where: { roleId: assignment.roleId } });
      if (owners <= 1) {
        throw new AppError(409, "The organization must keep at least one owner", "LAST_OWNER");
      }
    }

    await prisma.userRole.delete({ where: { id: assignment.id } });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});
