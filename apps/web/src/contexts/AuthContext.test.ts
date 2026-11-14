import { landingPath, permissionsOf, roleAllows } from "../lib/permissions";

/**
 * A role reaches the browser in two shapes: the owner's permissions arrive as the single
 * string "*", and everybody else's as an array of keys. Reading `.includes` straight off
 * the field threw for every role-created account, which is why staff could sign in and then
 * meet a broken page. These tests pin both shapes, and where each kind of user belongs.
 */
const owner = {
  id: "u1",
  email: "owner@kazios.co.ke",
  name: "Owner",
  status: "ACTIVE",
  organizationId: "o1",
  roles: [{ type: "OWNER", permissions: "*" as const }],
};

const attendant = {
  id: "u2",
  email: "grace@kazios.co.ke",
  name: "Grace Wambui",
  status: "ACTIVE",
  organizationId: "o1",
  roles: [
    {
      type: "ATTENDANT",
      permissions: ["pos.sale", "pos.sales.view", "products.view", "inventory.view"],
    },
  ],
};

describe("AuthContext permissions", () => {
  describe("permissionsOf", () => {
    it("reads the wildcard the owner is given", () => {
      expect(permissionsOf(owner.roles[0])).toEqual(["*"]);
    });

    it("reads a role's key list", () => {
      expect(permissionsOf(attendant.roles[0])).toContain("pos.sale");
    });

    it("does not throw on a role with no permissions at all", () => {
      const empty = { type: "CUSTOM", permissions: undefined as unknown as "*" };
      expect(permissionsOf(empty)).toEqual([]);
    });
  });

  describe("roleAllows", () => {
    it("lets the owner through any permission", () => {
      expect(roleAllows(owner, "reports.view")).toBe(true);
      expect(roleAllows(owner, "users.manage")).toBe(true);
    });

    it("grants an attendant only what the role lists", () => {
      expect(roleAllows(attendant, "pos.sale")).toBe(true);
      expect(roleAllows(attendant, "reports.view")).toBe(false);
      expect(roleAllows(attendant, "users.manage")).toBe(false);
    });

    it("refuses everybody when nobody is signed in", () => {
      expect(roleAllows(null, "pos.sale")).toBe(false);
    });
  });

  describe("landingPath", () => {
    it("sends the owner to the dashboard", () => {
      expect(landingPath(owner)).toBe("/dashboard");
    });

    it("sends an attendant to the till, not to a report they cannot read", () => {
      expect(landingPath(attendant)).toBe("/pos");
    });

    it("keeps the dashboard for somebody who may neither sell nor report", () => {
      const readonly = { ...attendant, roles: [{ type: "CUSTOM", permissions: [] as string[] }] };
      expect(landingPath(readonly)).toBe("/dashboard");
    });

    it("sends a signed out visitor to sign in", () => {
      expect(landingPath(null)).toBe("/login");
    });
  });
});