import type { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "./auth";

export async function auditMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const originalSend = res.json.bind(res);
  res.json = function (body: any) {
    if (req.organizationId && req.userId && res.statusCode >= 200 && res.statusCode < 300) {
      prisma.auditLog
        .create({
          data: {
            organizationId: req.organizationId,
            userId: req.userId,
            entity: req.path.split("/")[2]?.toUpperCase() || "UNKNOWN",
            entityId: (body && (body.data?.id || body.id)) || "",
            action: req.method,
            changes: { method: req.method, path: req.path, body: req.body },
            ip: req.ip,
            userAgent: req.get("User-Agent") || "",
          },
        })
        .catch(() => undefined);
    }
    return originalSend(body);
  };
  next();
}
