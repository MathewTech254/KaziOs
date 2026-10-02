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
const testUrl = process.env.TEST_DATABASE_URL || devUrl.replace(/\/[^/?]*(\?|$)/, "/kazios_test$1");

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
console.log(`\nIntegration database: ${new URL(testUrl).pathname.replace(/^\//, "")}\n`);

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
  { ...prismaEnv, JWT_SECRET: process.env.JWT_SECRET || "integration-suite-secret-32-characters" }
);
process.exit(status);
