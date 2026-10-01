import type { Request } from "express";
import type { AuthRequest } from "../middleware/auth";

/**
 * Tenant and role scoping helpers shared by every business route.
 *
 * The organization is always resolved from the authenticated session, never from
 * client supplied values. Role assignments may additionally restrict a user to a
 * set of branches and/or warehouses.
 */

export function getOrganizationId(req: Request): string | undefined {
  return (req as AuthRequest).organizationId;
}

export function getUserId(req: Request): string | undefined {
  return (req as AuthRequest).userId;
}

export function getScopedValues(req: Request, key: "branchId" | "warehouseId"): string[] {
  const roles = (req as AuthRequest).roles || [];
  const values = roles.flatMap(assignment => {
    const relation = key === "branchId" ? assignment.branch : assignment.warehouse;
    const direct = key === "branchId" ? assignment.branchId : assignment.warehouseId;
    return [typeof direct === "string" ? direct : undefined, relation?.id].filter(
      (value): value is string => Boolean(value)
    );
  });
  return Array.from(new Set(values));
}

/**
 * An empty scope list means the role is not restricted. A restricted role may only
 * touch entities that it has been explicitly assigned.
 */
export function isAllowed(value: string | null | undefined, scopedValues: string[]): boolean {
  return scopedValues.length === 0 || (value ? scopedValues.includes(value) : false);
}
