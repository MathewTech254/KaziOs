import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { validateSession } from "../lib/auth";
import type { EntitlementSnapshot } from "../services/entitlements";

export interface AuthRequest extends Request {
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  user?: any;
  roles?: any[];
  /**
   * The business's resolved plan, attached by the entitlement middleware.
   *
   * Optional because it is only attached on routes that ask for it: most routes care about
   * permissions, not about what the business has paid for, and resolving a plan snapshot
   * on every request would be work most of them throw away.
   */
  entitlements?: EntitlementSnapshot;
}

/**
 * Reads the bearer token from the Authorization header, falling back to the `access_token`
 * query parameter.
 *
 * A browser's EventSource cannot attach an Authorization header to the request it opens,
 * so the real time notification stream has no other way to prove who it belongs to. That
 * fallback is deliberately confined to this function rather than being honoured on every
 * route, because a token in a URL is liable to be written to access logs; only the
 * stream, which is already an authenticated long lived connection, uses it.
 */
function readToken(req: Request): string | undefined {
  const header = req.headers.authorization?.replace("Bearer ", "");
  if (header) return header;
  const fromQuery = req.query?.access_token;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  return req.signedCookies?.sid;
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = readToken(req);
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
    const hasPerm = roles.some(
      (r: any) => r.role.permissions.includes("*") || r.role.permissions.includes(permission)
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
