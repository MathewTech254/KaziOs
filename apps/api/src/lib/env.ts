import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";

/**
 * Loads the repository root .env first, then the API's own .env to fill gaps.
 *
 * The API runs with its working directory at apps/api, and Prisma loads .env relative
 * to that, so apps/api/.env was historically the only file it reliably read. The
 * repository root .env holds the integration keys (Paystack live, email, SMS, AI,
 * object storage) that every service shares, so it must load before the API's own
 * .env, otherwise the API's test overrides of the integration keys hide the live keys
 * from the Paystack client. dotenv never overwrites an already-set value, so whichever
 * file loads first wins per key.
 *
 * The API's own config (DATABASE_URL, SESSION_SECRET, API_PORT) lives in
 * apps/api/.env and is intentionally loaded second, so it can never be overridden
 * by the root file.
 */
const repoRootEnv = path.resolve(__dirname, "..", "..", ".env");
const apiEnv = path.resolve(__dirname, "..", ".env");

export function loadRepoEnv(): void {
  if (fs.existsSync(repoRootEnv)) {
    dotenv.config({ path: repoRootEnv, override: false });
  }
  if (fs.existsSync(apiEnv)) {
    dotenv.config({ path: apiEnv, override: false });
  }
}
