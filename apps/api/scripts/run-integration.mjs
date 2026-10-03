// Runs the integration suite against a dedicated test database.
//
//   npm run test:integration
//
// The suite talks to a real Postgres, because the failures worth catching here are
// tenant leaks, permission gaps and unbalanced ledgers, and none of those are visible
// to a mocked unit test. `jest --testPathPattern=*.integration.ts` on its own passed with
// no tests found at all, which read as a green gate while guarding nothing.
//
// It refuses to run against a database that is not named like a test database, so
// pointing DATABASE_URL at the development one cannot empty it. Point TEST_DATABASE_URL
// at your own scratch database to override the default.

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";
import * as fs from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");

/** Read .env without a dependency, so this runs before anything is installed. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#") && line.includes("="))
      .map(line => {
        const index = line.indexOf("=");
        return [
          line.slice(0, index).trim(),
          line
            .slice(index + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        ];
      })
  );
}

const fileEnv = readEnvFile(path.join(apiRoot, ".env"));
const devUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
if (!devUrl) {
  console.error("DATABASE_URL is not set and none was found in apps/api/.env.");
  process.exit(1);
}

function isTestDatabase(urlString) {
  try {
    return /test/i.test(new URL(urlString).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}

/**
 * A dedicated test database is derived from whatever the development URL points at, by
 * swapping the database name for kazios_test. Point TEST_DATABASE_URL somewhere else to
 * override, for a shared CI database that is not alongside the dev one.
 */
/**
 * Caps the connection pool for the suite.
 *
 * The harness opens its own PrismaClient while every route imports the application's
 * client, so the suite runs two pools at once. Each defaults to `num_cpus * 2 + 1`, which
 * on a many core machine is enough to exhaust Postgres connections or the Windows
 * ephemeral port range. That surfaced as "Server has closed the connection" followed by
 * `connect EACCES`, failing ten tests that had already passed a minute earlier. A suite
 * that fails intermittently is worse than no suite, because it teaches people to ignore
 * red, so the pool is pinned to a number the suite can never exceed.
 *
 * The suite runs `--runInBand`, so a single connection would technically do. Five leaves
 * headroom for the migrate connection and for transactions that hold one open.
 */
function withBoundedPool(urlString) {
  try {
    const url = new URL(urlString);
    url.searchParams.set("connection_limit", "5");
    // Also bound the pool lifetime. Without this, idle connections are held past the end
    // of the run and pile up against anything else using the same database.
    url.searchParams.set("pool_timeout", "20");
    return url.toString();
  } catch {
    return urlString;
  }
}

const testUrl = withBoundedPool(
  process.env.TEST_DATABASE_URL || devUrl.replace(/\/[^/?]*(\?|$)/, "/kazios_test$1")
);

// The only guard that matters. Everything below this line writes and deletes rows, so a
// mistyped URL pointing at a live database must stop the run rather than empty it.
if (!isTestDatabase(testUrl)) {
  console.error(
    `Refusing to run the integration suite against "${testUrl}": the database name must ` +
      `contain "test". Set TEST_DATABASE_URL to a scratch database.`
  );
  process.exit(1);
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: apiRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

const prismaEnv = { DATABASE_URL: testUrl };
const testDbName = new URL(testUrl).pathname.replace(/^\//, "");
console.log(`\nIntegration database: ${testDbName}\n`);

/**
 * Creates the test database if it is not there yet.
 *
 * `migrate deploy` refuses to run against a database that does not exist, and a CI runner
 * has exactly that situation: the Postgres service creates only the database named in
 * POSTGRES_DB, which is `kazios`. Locally the database survives from the last run, so the
 * gap is invisible until CI goes red on a fresh runner with a misleading "database does
 * not exist" error that reads like a migration problem.
 *
 * Created through the `postgres` maintenance database, because connecting to the target
 * in order to create it is not possible. CREATE DATABASE cannot run inside a transaction,
 * so it is issued on its own.
 */
async function ensureTestDatabase() {
  const { PrismaClient } = await import("@prisma/client");
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });

  try {
    const rows = await admin.$queryRawUnsafe(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      testDbName
    );
    if (rows.length) {
      console.log(`Database ${testDbName} already exists.`);
      return true;
    }
    // Interpolated rather than parameterised because CREATE DATABASE does not accept a
    // bind parameter. The name is quoted, and it was already checked to look like a test
    // database by the guard above.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName.replace(/"/g, '""')}"`);
    console.log(`Created database ${testDbName}.`);
    return true;
  } catch (err) {
    console.error(`\nCould not reach Postgres to create ${testDbName}: ${err.message}`);
    console.error("Is Postgres running, and do these credentials allow creating databases?");
    return false;
  } finally {
    await admin.$disconnect().catch(() => undefined);
  }
}

if (!(await ensureTestDatabase())) {
  process.exit(1);
}

// The schema has to exist before anything runs. `migrate deploy` applies the real
// migrations, so the tests exercise the schema production actually ships rather than
// whatever a db push would invent.
const migrate = run("npx prisma migrate deploy", [], prismaEnv);
if (migrate !== 0) {
  console.error("\nCould not prepare the integration database. Is Postgres running?");
  process.exit(migrate);
}

const status = run(
  "npx jest --testPathPattern=.*\\.integration\\.ts$ --runInBand",
  [],
  {
    ...prismaEnv,
    JWT_SECRET: process.env.JWT_SECRET || "integration-suite-secret-32-characters",
    // The suite must never reach a real provider. Registering a business sends a welcome
    // email, so once the root .env carries a working Resend key these tests would quietly
    // mail an address they invented, on every run, for ever. Console mode keeps the body in
    // the log where a test can assert on it.
    EMAIL_PROVIDER: "console",
    EMAIL_API_KEY: "",
    // Likewise, no card payment should be possible against a live gateway.
    PAYSTACK_SECRET_KEY: "",
  }
);
process.exit(status);
