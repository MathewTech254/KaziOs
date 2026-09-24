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

  for (const name of ["DATABASE_URL", "SESSION_SECRET", "JWT_SECRET", "CORS_ORIGIN"]) {
    if (!env[name]?.trim()) problems.push(`${name} is not set`);
  }

  const jwt = env.JWT_SECRET || "";
  if (jwt.startsWith(DEVELOPMENT_DEFAULTS.JWT_SECRET)) problems.push("JWT_SECRET still uses the development default");
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

  if (env.CORS_ORIGIN === "*") problems.push('CORS_ORIGIN must be the exact web origin, not "*"');

  return problems;
}

export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = productionEnvProblems(env);
  if (problems.length === 0) return;

  throw new Error(
    `Cannot start in production:\n  - ${problems.join("\n  - ")}\n` +
      "Set these in the host's environment (Render: Environment tab), then redeploy."
  );
}
