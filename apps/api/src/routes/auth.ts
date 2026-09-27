import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { hashPassword, signToken, createSession, AppError } from "../lib";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { zRegisterSchema, zLoginSchema, zForgotPasswordSchema, zResetPasswordSchema } from "@kazios/validation";
import { sendMail, welcomeEmail, passwordChangedEmail } from "../lib/email";
import { consumeResetToken, inspectResetToken, issuePasswordReset } from "../lib/passwordReset";

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

    // A welcome message is a courtesy, never a condition: a failed email must not undo
    // an account that was created successfully.
    sendMail(welcomeEmail(result.user.email, result.user.name, result.org.name));
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
/**
 * Starts a password reset. The response is identical whether or not the address is
 * registered: telling a stranger which emails exist is how account lists get built.
 */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const data = zForgotPasswordSchema.parse(req.body);
    const email = data.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, status: true } });

    if (user && user.status === "ACTIVE") {
      await issuePasswordReset(user.id, user.email, user.name);
    }

    res.json({
      data: {
        message: "If that email address belongs to a KaziOS account, a reset link is on its way.",
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Lets the reset form refuse a dead link before the user types a new password. */
authRouter.post("/reset-password/verify", async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? "");
    const outcome = await inspectResetToken(token);
    if (!outcome.ok) {
      const message =
        outcome.reason === "EXPIRED"
          ? "This reset link has expired. Please request a new one."
          : outcome.reason === "USED"
          ? "This reset link has already been used. Please request a new one."
          : "This reset link is not valid.";
      throw new AppError(400, message, "RESET_TOKEN_" + outcome.reason);
    }
    res.json({ data: { valid: true, email: maskEmail(outcome.email || "") } });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const data = zResetPasswordSchema.parse(req.body);
    const result = await consumeResetToken(data.token, data.password);

    if (!result.ok) {
      const message =
        result.reason === "EXPIRED"
          ? "This reset link has expired. Please request a new one."
          : result.reason === "USED"
          ? "This reset link has already been used."
          : "This reset link is not valid.";
      throw new AppError(400, message, "RESET_TOKEN_" + result.reason);
    }

    // Confirmation goes to the address on the account, never to the request body, so a
    // reset request cannot be used to send mail to somebody else.
    const user = await prisma.user.findUnique({ where: { id: result.userId! }, select: { email: true, name: true } });
    if (user) sendMail(passwordChangedEmail(user.email, user.name));

    res.json({ data: { message: "Your password has been changed. Please sign in with it." } });
  } catch (err) {
    next(err);
  }
});

/** Shows enough of an address to be recognisable without echoing it back. */
function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "your account";
  const head = name.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

