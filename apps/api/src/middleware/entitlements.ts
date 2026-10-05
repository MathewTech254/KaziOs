import type { Response, NextFunction } from "express";
import type { AuthRequest } from "./auth";
import { requireAuth } from "./auth";
import { AppError } from "./errorHandler";
import { assertFeature, getEntitlements, type EntitlementSnapshot } from "../services/entitlements";

/**
 * Server side entitlement checks.
 *
 * These exist because the browser is not a security boundary. Hiding a button, a menu
 * item or a whole page in React stops an honest user from clicking something; it does
 * nothing at all to somebody who edits the JavaScript, calls the API directly with curl,
 * or replays a request they captured. The only check that counts runs here, on the server,
 * against the plan the business actually holds.
 *
 * The frontend still reads the same entitlements to decide what to show. That is a
 * convenience, not the enforcement: `GET /billing/entitlements` is a display aid, and
 * every route it hints at checks again regardless of what it returned.
 */

/** Attaches the resolved entitlements to the request, for routes that check several. */
export async function withEntitlements(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.organizationId) {
      next(new AppError(401, "Authentication required"));
      return;
    }
    req.entitlements = await getEntitlements(req.organizationId);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires a capability the business's plan does not include.
 *
 * Used on the routes a paid capability owns. The refusal names the feature, the plan and
 * where to upgrade, so the interface can offer the next step rather than printing a dead end.
 */
export function requireFeature(featureKey: string, featureName?: string) {
  return async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.organizationId) {
        next(new AppError(401, "Authentication required"));
        return;
      }

      const entitlements = req.entitlements ?? (await getEntitlements(req.organizationId));

      await assertFeature(entitlements, featureKey, { featureName });
      next();
    } catch (err) {
      // Handed to the error handler rather than written here, so an entitlement refusal is
      // shaped exactly like every other error this API returns.
      next(err);
    }
  };
}

/** Reads the entitlements attached by `withEntitlements`, resolving them if absent. */
export async function entitlementsFor(req: AuthRequest): Promise<EntitlementSnapshot> {
  if (req.entitlements) return req.entitlements;
  if (!req.organizationId) throw new AppError(401, "Authentication required");
  const resolved = await getEntitlements(req.organizationId);
  req.entitlements = resolved;
  return resolved;
}

/** requireFeature plus requireAuth, for the common case of a gated route. */
export function requireEntitledFeature(featureKey: string, featureName?: string) {
  return [requireAuth, withEntitlements, requireFeature(featureKey, featureName)];
}
