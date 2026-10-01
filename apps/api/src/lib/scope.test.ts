import type { Request } from "express";
import { getOrganizationId, getScopedValues, getUserId, isAllowed } from "./scope";

/**
 * These helpers are the whole of tenant and branch isolation. Every business route reads
 * the organization from the session and narrows to branches and warehouses through these
 * functions, so a mistake here does not produce a visible error: it quietly shows one
 * branch another branch's stock, sales or customer list.
 */

const request = (session: Record<string, unknown>) => session as unknown as Request;

const restrictedTo = (...ids: string[]) =>
  request({ organizationId: "org_1", userId: "usr_1", roles: ids.map(id => ({ branchId: id })) });

const unrestricted = () => request({ organizationId: "org_1", userId: "usr_1", roles: [] });

describe("session identity", () => {
  it("reads the organization and user from the session, not the body", () => {
    const req = request({ organizationId: "org_1", userId: "usr_1" });
    expect(getOrganizationId(req)).toBe("org_1");
    expect(getUserId(req)).toBe("usr_1");
  });

  it("is undefined for an unauthenticated request rather than throwing", () => {
    // The auth middleware is the thing that must refuse; these must not crash first.
    expect(getOrganizationId(request({}))).toBeUndefined();
    expect(getUserId(request({}))).toBeUndefined();
  });
});

describe("getScopedValues", () => {
  it("is empty for a role with no branch restriction", () => {
    // Empty means unrestricted, which is the difference between "all branches" and "none".
    expect(getScopedValues(unrestricted(), "branchId")).toEqual([]);
  });

  it("collects the branches a user is assigned to", () => {
    expect(getScopedValues(restrictedTo("br_ngong", "br_west"), "branchId")).toEqual([
      "br_ngong",
      "br_west",
    ]);
  });

  it("never repeats a branch, so scope checks cannot be widened by duplicates", () => {
    const req = request({
      roles: [{ branchId: "br_ngong" }, { branchId: "br_ngong" }, { branchId: "br_mombasa" }],
    });
    expect(getScopedValues(req, "branchId")).toEqual(["br_ngong", "br_mombasa"]);
  });

  it("falls back to the loaded relation when the id is not denormalized", () => {
    const req = request({ roles: [{ branch: { id: "br_westlands" } }] });
    expect(getScopedValues(req, "branchId")).toEqual(["br_westlands"]);
  });

  it("keeps branch and warehouse scopes apart", () => {
    // Mixing them up would let a branch cashier post stock in another branch's warehouse.
    const req = request({ roles: [{ branchId: "br_1", warehouseId: "wh_1" }] });
    expect(getScopedValues(req, "branchId")).toEqual(["br_1"]);
    expect(getScopedValues(req, "warehouseId")).toEqual(["wh_1"]);
  });

  it("is empty rather than throwing when the session has no roles at all", () => {
    expect(getScopedValues(request({}), "branchId")).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("allows anything when the role is unrestricted", () => {
    expect(isAllowed("br_anything", [])).toBe(true);
    expect(isAllowed(null, [])).toBe(true);
  });

  it("allows a branch the user is assigned to", () => {
    expect(isAllowed("br_ngong", ["br_ngong", "br_west"])).toBe(true);
  });

  it("refuses a branch the user is not assigned to", () => {
    // This is the cross-branch leak the whole helper exists to prevent.
    expect(isAllowed("br_mombasa", ["br_ngong", "br_west"])).toBe(false);
  });

  it("refuses a missing branch on a restricted role", () => {
    // An entity with no branch set must not slip past a role that is limited to some.
    expect(isAllowed(null, ["br_ngong"])).toBe(false);
    expect(isAllowed(undefined, ["br_ngong"])).toBe(false);
    expect(isAllowed("", ["br_ngong"])).toBe(false);
  });

  it("matches exactly rather than by prefix", () => {
    // A prefix match would let "br_ngong_2" pass for "br_ngong".
    expect(isAllowed("br_ngong_2", ["br_ngong"])).toBe(false);
  });
});
