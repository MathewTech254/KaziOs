import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { hashPassword, signToken, createSession, AppError } from "../lib";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { zRegisterSchema, zLoginSchema } from "@kazios/validation";

export const authRouter = Router();

authRouter.post("/register", async (req, res, next) => {
  try {
    const data = zRegisterSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError(409, "Email already registered", "EMAIL_EXISTS");

    const passwordHash = await hashPassword(data.password);
    const slug = data.organizationName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");

    const result = await prisma.$transaction(async (tx: any) => {
      const org = await tx.organization.create({
        data: {
          name: data.organizationName,
          slug: `${slug}-${randomUUID().slice(-4)}`,
          country: data.country,
          currency: data.currency,
          timezone: data.timezone,
        },
      });

      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          name: data.name,
          organizationId: org.id,
          status: "ACTIVE",
        },
      });

      const ownerRole = await tx.role.create({
        data: {
          name: "Owner",
          type: "OWNER",
          description: "Full access owner",
          organizationId: org.id,
          permissions: ["*"],
        },
      });

      await tx.userRole.create({ data: { userId: user.id, roleId: ownerRole.id } });

      const mainBranch = await tx.branch.create({
        data: { name: "Main Branch", code: "MAIN", organizationId: org.id, isMain: true },
      });

      await tx.warehouse.create({
        data: { name: "Main Warehouse", code: "WH-01", organizationId: org.id, branchId: mainBranch.id },
      });

      await tx.account.createMany({
        data: [
          { code: "1000", name: "Cash", type: "ASSET", organizationId: org.id, isSystem: true },
          { code: "1100", name: "Bank", type: "ASSET", organizationId: org.id, isSystem: true },
          { code: "2000", name: "Accounts Payable", type: "LIABILITY", organizationId: org.id, isSystem: true },
          { code: "4000", name: "Sales Revenue", type: "REVENUE", organizationId: org.id, isSystem: true },
          { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", organizationId: org.id, isSystem: true },
          { code: "5100", name: "General Expenses", type: "EXPENSE", organizationId: org.id, isSystem: true },
        ],
      });

      await tx.taxCategory.createMany({
        data: [
          { name: "VAT Standard", rate: 16, mode: "EXCLUSIVE", organizationId: org.id },
          { name: "Zero Rated", rate: 0, mode: "EXCLUSIVE", organizationId: org.id },
          { name: "Exempt", rate: 0, mode: "EXCLUSIVE", organizationId: org.id },
        ],
      });

      return { org, user, ownerRole };
    });

    const session = await createSession(result.user.id);
    const token = signToken({
      userId: result.user.id,
      sessionId: session.id,
      organizationId: result.org.id,
    });

    res.status(201).json({
      data: {
        token,
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          status: result.user.status,
          organizationId: result.org.id,
          roles: [{ type: result.ownerRole.type, permissions: result.ownerRole.permissions }],
        },
        organization: { id: result.org.id, name: result.org.name },
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const data = zLoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: data.email },
      include: { roles: { include: { role: true, branch: true, warehouse: true } } },
    });
    if (!user) throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");
    if (user.status !== "ACTIVE") {
      throw new AppError(401, "Account is not active", "ACCOUNT_NOT_ACTIVE");
    }
    const ok = await bcrypt.compare(data.password, user.passwordHash);
    if (!ok) throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");

    const session = await createSession(user.id, req.ip, req.get("User-Agent") || undefined);
    const token = signToken({
      userId: user.id,
      sessionId: session.id,
      organizationId: user.organizationId,
    });

    res.json({
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status,
          organizationId: user.organizationId,
          roles: user.roles.map((role: any) => ({
            type: role.role.type,
            permissions: role.role.permissions,
            branchId: role.branchId,
            warehouseId: role.warehouseId,
          })),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await prisma.session.delete({ where: { id: req.sessionId } }).catch(() => {});
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { roles: { include: { role: true, branch: true, warehouse: true } } },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        status: user.status,
        organizationId: user.organizationId,
        roles: user.roles.map((r: any) => ({
          type: r.role.type,
          permissions: r.role.permissions,
          branchId: r.branchId,
          warehouseId: r.warehouseId,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});