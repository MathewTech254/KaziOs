/**
 * Production configuration checks. Kept as a pure function of an environment
 * record so it can be exercised directly, and so one boot reports every problem
 * instead of failing on them one at a time.
 */

const DEVELOPMENT_DEFAULTS = {
  JWT_SECRET: "dev-jwt-secret",
  SESSION_SECRET: "dev-session-secret",
} as const;

export function productionEnvProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];

  const problems: string[] = [];

  for (const name of ["DATABASE_URL", "SESSION_SECRET", "JWT_SECRET"]) {
    if (!env[name]?.trim()) problems.push(`${name} is not set`);
  }

  const jwt = env.JWT_SECRET || "";
  if (jwt.startsWith(DEVELOPMENT_DEFAULTS.JWT_SECRET))
    problems.push("JWT_SECRET still uses the development default");
  if (jwt && !jwt.startsWith(DEVELOPMENT_DEFAULTS.JWT_SECRET) && jwt.length < 32) {
    problems.push("JWT_SECRET must be at least 32 characters");
  }

  const session = env.SESSION_SECRET || "";
  if (session.startsWith(DEVELOPMENT_DEFAULTS.SESSION_SECRET)) {
    problems.push("SESSION_SECRET still uses the development default");
  }
  if (session && !session.startsWith(DEVELOPMENT_DEFAULTS.SESSION_SECRET) && session.length < 32) {
    problems.push("SESSION_SECRET must be at least 32 characters");
  }

  return problems;
}

/**
 * CORS is a browser concern, not a credential, so a missing origin must not stop the
 * API from serving: the web app is often deployed after the API, and its URL is not
 * known until then. Reported loudly instead so it is not forgotten.
 */
export function corsOriginWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = (env.CORS_ORIGIN || "").trim();
  if (!configured) {
    return "CORS_ORIGIN is not set. Browser requests from the web app will be blocked until it is (Render: Environment tab).";
  }
  if (configured === "*") {
    return 'CORS_ORIGIN is "*", which cannot be used with credentialed requests. Set the exact web origin instead.';
  }
  return null;
}

export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = productionEnvProblems(env);
  if (problems.length === 0) return;

  throw new Error(
    `Cannot start in production:\n  - ${problems.join("\n  - ")}\n` +
      "Set these in the host's environment (Render: Environment tab), then redeploy."
  );
}
