import { prisma } from "../lib/prisma";
import { auditMiddleware, redactSensitive } from "./audit";

/**
 * The audit log records who did what. It must never become a second, less protected copy
 * of the credentials the system is trusted to keep safe.
 *
 * These tests exist because of a real defect: the middleware stored the raw request body,
 * so every staff password an owner created through `POST /users` was persisted in
 * cleartext. The audit trail is the table most likely to be exported, inspected by a
 * report, or copied into a backup, so a leak there is a leak everywhere.
 */
jest.mock("../lib/prisma", () => ({
  prisma: { auditLog: { create: jest.fn() } },
}));

// Held as a jest.fn() reference rather than a bound method. Binding would satisfy the
// unbound-method lint rule but strip Jest's mock controls, so the assertions that prove
// the middleware did (or did not) write anything would silently stop working.
// eslint-disable-next-line @typescript-eslint/unbound-method
const createAudit = prisma.auditLog.create as unknown as jest.Mock;

/** The exact body `POST /users` receives when an owner adds a cashier. */
const staffCreation = {
  email: "cashier@highlands.test",
  name: "Grace Wanjiru",
  password: "KaziOS!RealSecret2026",
  roleId: "role_cashier",
};

/**
 * Drives the middleware the way Express does, then lets the route answer.
 *
 * The audit write is triggered by `res.json`, so a harness that never calls it would
 * assert nothing at all and pass against a completely broken middleware. The response is
 * captured on the res object first, because the middleware replaces `res.json` with its
 * own wrapper and the harness has to reach the underlying one.
 */
function runMiddleware(req: Record<string, unknown>, statusCode = 201) {
  const originalJson = jest.fn();
  const res: any = { statusCode, json: originalJson, get: jest.fn(() => "jest") };
  const next = jest.fn();
  // Express puts header lookup on the request, not the response, so the mock has to
  // carry it too. Without it the middleware throws before it can write anything and the
  // test would pass for entirely the wrong reason.
  const request: any = { get: jest.fn(() => "jest-agent"), ...req };
  auditMiddleware(request, res, next);
  return {
    res,
    next,
    /** Answers the request the way a route handler does. */
    respond: (body: unknown = { data: { id: "usr_new" } }) => res.json(body),
    written: () => createAudit.mock.calls[0]?.[0]?.data,
  };
}

beforeEach(() => {
  createAudit.mockReset();
  createAudit.mockResolvedValue({});
});

describe("redactSensitive", () => {
  it("removes a password from a staff creation body", () => {
    const output = redactSensitive(staffCreation) as Record<string, unknown>;
    expect(output.password).toBe("[redacted]");
  });

  it("keeps the fields an auditor actually needs", () => {
    // Redaction that erased everything would make the audit log useless, which is its
    // own kind of failure: an untraceable system.
    const output = redactSensitive(staffCreation) as Record<string, unknown>;
    expect(output.email).toBe("cashier@highlands.test");
    expect(output.name).toBe("Grace Wanjiru");
    expect(output.roleId).toBe("role_cashier");
  });

  it("does not mutate the original body the route still has to hash", () => {
    // The route reads req.body.password after this runs. Scrubbing in place would hand
    // the hasher a literal "[redacted]" and silently break staff sign in.
    const body = { ...staffCreation };
    redactSensitive(body);
    expect(body.password).toBe("KaziOS!RealSecret2026");
  });

  it("catches a password under any casing, because JSON keys are not normalised", () => {
    const output = redactSensitive({ Password: "x", PassWord: "y", passWord: "z" }) as Record<
      string,
      unknown
    >;
    expect(output.Password).toBe("[redacted]");
    expect(output.PassWord).toBe("[redacted]");
    expect(output.passWord).toBe("[redacted]");
  });

  it("redacts the other credential bearing fields, not just passwords", () => {
    const output = redactSensitive({
      apiKey: "sk_live_1",
      clientSecret: "cs_1",
      token: "tok_1",
      refreshToken: "rt_1",
      authorization: "Bearer abc",
      passwordHash: "$2b$12$hash",
    }) as Record<string, unknown>;
    for (const value of Object.values(output)) expect(value).toBe("[redacted]");
  });

  it("reaches secrets nested inside objects and arrays", () => {
    // A nested credential is still a credential; only inspecting the top level is the
    // mistake this guards against.
    const output = redactSensitive({
      user: { profile: { password: "nested-secret" } },
      accounts: [{ credentials: { password: "in-array" } }],
    }) as any;
    expect(output.user.profile.password).toBe("[redacted]");
    expect(output.accounts[0].credentials.password).toBe("[redacted]");
  });

  it("survives a body that is not an object at all", () => {
    // A route can receive a bare string or number, and Prisma's Json column rejects
    // undefined outright, so this has to normalise rather than throw.
    expect(redactSensitive("plain text")).toBe("plain text");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeNull();
  });

  it("terminates on a self referencing body instead of overflowing the stack", () => {
    const cyclic: any = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redactSensitive(cyclic)).not.toThrow();
  });
});

describe("auditMiddleware", () => {
  it("never writes a plaintext password to the audit log", async () => {
    const { next, respond, written, res } = runMiddleware({
      organizationId: "org_1",
      userId: "usr_owner",
      method: "POST",
      path: "/api/v1/users",
      ip: "10.0.0.1",
      body: staffCreation,
    });
    next();
    respond();

    // The write is fire and forget, so let the microtask queue drain.
    await new Promise(resolve => setImmediate(resolve));

    const data = written();
    expect(data).toBeDefined();
    expect(JSON.stringify(data.changes)).not.toContain("KaziOS!RealSecret2026");
    expect(data.changes.body.password).toBe("[redacted]");
    // The route still answered normally: auditing is a side effect, never a gate.
    expect(res.statusCode).toBe(201);
  });

  it("still records the action, so the trail survives the redaction", () => {
    const { next, respond, written } = runMiddleware({
      organizationId: "org_1",
      userId: "usr_owner",
      method: "POST",
      path: "/api/v1/users",
      ip: "10.0.0.1",
      body: staffCreation,
    });
    next();
    respond();
    expect(written().entity).toBe("USERS");
    expect(written().action).toBe("POST");
    expect(written().changes.body.email).toBe("cashier@highlands.test");
  });

  it("writes nothing for an unauthenticated request, which has no tenant to attribute", () => {
    // Register and password reset run before a session exists. Logging them would either
    // drop the organization or attribute the event to nobody.
    const { next, respond } = runMiddleware({ method: "POST", path: "/api/v1/auth/register" });
    next();
    respond();
    expect(createAudit).not.toHaveBeenCalled();
  });

  it("writes nothing for a failed request, which changed nothing", () => {
    const { next, respond } = runMiddleware(
      { organizationId: "org_1", userId: "usr_1", method: "POST", path: "/api/v1/pos/sale" },
      400
    );
    next();
    respond();
    expect(createAudit).not.toHaveBeenCalled();
  });
});
