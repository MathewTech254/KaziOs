import { LoginPage } from "../pages/LoginPage";
import { router } from "./router";

// The route table imports every page, and the API client reads import.meta.env, which
// Jest's CommonJS transform cannot parse. Mocking the module keeps the real one from
// being evaluated at all.
jest.mock("../lib/api", () => ({
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  apiHost: () => "",
  getApiError: (err: unknown) => (err as Error)?.message || "error",
}));

/**
 * The sign in page existed but was never added to the route table, so every link to
 * /login — the auth guard, the 401 handler, and five pages — landed on the catch all and
 * rendered "Something went wrong". These assertions keep the route wired up.
 */
type RouteLike = {
  path?: string;
  element?: { type?: unknown };
  errorElement?: unknown;
};

const routes = router.routes as unknown as RouteLike[];

describe("router table", () => {
  it("serves the sign in page at /login", () => {
    const route = routes.find(candidate => candidate.path === "/login");

    expect(route).toBeDefined();
    expect(route!.element!.type).toBe(LoginPage);
  });

  it("keeps the catch all last so real routes still win", () => {
    const last = routes[routes.length - 1];

    expect(last.path).toBe("*");
    expect(routes.filter(route => route.path === "*")).toHaveLength(1);
  });

  it("gives every route an error boundary", () => {
    const withoutBoundary = routes.filter(route => !route.errorElement);

    expect(withoutBoundary.map(route => route.path)).toEqual([]);
  });
});