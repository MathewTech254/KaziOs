import type { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { AuthRequest } from "./auth";

/**
 * Request body keys that must never be written to the audit log, and therefore never to
 * a database row, a backup, or an analytics export.
 *
 * This is not a theoretical concern. `POST /users` is how an owner gives a cashier
 * their first password, and the audit middleware sits above every route, so an
 * unredacted body stored that password in cleartext. Any account that can read audit
 * rows, export them, or copy the database would then hold every worker's credential.
 * The staff list is the single most sensitive table in an ERP, so the list is treated as
 * a denylist that is extended rather than shortened: a new secret bearing field has to be
 * added here deliberately, not by accident.
 */
const REDACTED = "[redacted]";

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "confirmpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "secret",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
  "setcookie",
  "signature",
]);

/** Deepest body shape worth walking. Anything past this is pathological, not real. */
const MAX_DEPTH = 8;

/**
 * Returns a copy of a request body with every credential replaced by a marker.
 *
 * The original is never mutated: the route still receives the real password to hash, and
 * only the copy that is about to be persisted is scrubbed.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));
  // Prisma's Json field rejects undefined and functions, and a body that is not a plain
  // object (a string, a number, a stream) has nothing to redact.
  if (value === null || typeof value !== "object") return value ?? null;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactSensitive(entry, depth + 1);
  }
  return output;
}

/**
 * The resource a request acted on, taken from the mounted path.
 *
 * Routes are mounted under `/api/v1/<resource>`, so the segments are
 * ["", "api", "v1", "<resource>", ...]. Index 2 is the version, not the resource, so
 * reading it wrote "V1" against every audited action in the system, which made the
 * entity column useless for finding the records it was supposed to point at.
 */
function resourceFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const version = segments[1];
  const resource = version && /^v\d+$/i.test(version) ? segments[2] : segments[1];
  return resource?.toUpperCase() || "UNKNOWN";
}

export async function auditMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const originalSend = res.json.bind(res);
  res.json = function (body: any) {
    if (req.organizationId && req.userId && res.statusCode >= 200 && res.statusCode < 300) {
      prisma.auditLog
        .create({
          data: {
            organizationId: req.organizationId,
            userId: req.userId,
            entity: resourceFromPath(req.path),
            entityId: (body && (body.data?.id || body.id)) || "",
            action: req.method,
            // The scrubbed copy, never req.body itself. See SENSITIVE_KEYS above.
            changes: {
              method: req.method,
              path: req.path,
              body: redactSensitive(req.body),
            } as any,
            ip: req.ip,
            userAgent: req.get("User-Agent") || "",
          },
        })
        // An audit write must never fail the business operation it is recording, and it
        // must never take the API down either.
        .catch((err: unknown) => {
          console.error("Audit log write failed", {
            path: req.path,
            method: req.method,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return originalSend(body);
  };
  next();
}
