/**
 * What a role is allowed to do, and where a signed in user belongs.
 *
 * This lives apart from the React context so it can be reasoned about, and tested, without
 * dragging the API client in behind it.
 */

export interface UserRole {
  type: string;
  /**
   * The API sends an array of permission keys, except for OWNER where it sends the single
   * string "*". Both have to be read: reaching for `.includes` straight off this field
   * threw for every role-created account, because the owner was the only one whose value
   * happened to be a string.
   */
  permissions: string[] | "*";
  branchId?: string;
  warehouseId?: string;
}

/** The part of a signed in user the permission helpers need. */
export interface Principal {
  roles: UserRole[];
}

/** Every permission a role carries, whatever shape the API sent it in. */
export function permissionsOf(role: UserRole): string[] {
  if (Array.isArray(role.permissions)) return role.permissions;
  if (role.permissions === "*") return ["*"];
  return [];
}

export function roleAllows(user: Principal | null, permission: string): boolean {
  if (!user) return false;
  return user.roles.some(role => {
    const permissions = permissionsOf(role);
    return permissions.includes("*") || permissions.includes(permission);
  });
}

/**
 * Where a signed in user should land.
 *
 * The dashboard is a report, and an attendant is not given reports.view, so sending
 * everybody there left staff on a page that could only ever say "insufficient
 * permissions". Somebody who may sell goes to the till; everybody else keeps the
 * dashboard.
 */
export function landingPath(user: Principal | null): string {
  if (!user) return "/login";
  if (roleAllows(user, "reports.view")) return "/dashboard";
  if (roleAllows(user, "pos.sale")) return "/pos";
  return "/dashboard";
}