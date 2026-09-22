import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { validateSession } from "../lib/auth";

export interface AuthRequest extends Request {
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  user?: any;
  roles?: any[];
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.signedCookies?.sid;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const session = await validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { roles: { include: { role: true, branch: true, warehouse: true } } },
  });
  if (!user || user.status !== "ACTIVE") {
    res.status(401).json({ error: "Account not active" });
    return;
  }

  req.userId = user.id;
  req.sessionId = session.id;
  req.organizationId = user.organizationId;
  req.user = user;
  req.roles = user.roles;
  next();
}

export function requirePermission(permission: string) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const roles: any[] = req.roles || [];
    const hasPerm = roles.some((r: any) =>
      r.role.permissions.includes("*") || r.role.permissions.includes(permission)
    );
    if (!hasPerm) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function requireRole(...roleTypes: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const roles: any[] = req.roles || [];
    const hasRole = roles.some((r: any) => roleTypes.includes(r.role.type));
    if (!hasRole) {
      res.status(403).json({ error: "Insufficient role" });
      return;
    }
    next();
  };
}