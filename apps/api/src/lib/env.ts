import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";

/**
 * Loads the API's own .env first, then the repository root .env to fill the gaps.
 *
 * The API runs with its working directory at apps/api, and Prisma loads .env relative to
 * that, so apps/api/.env was the only file it reliably read. A developer who put their
 * Resend and Paystack keys in the root .env, where every other integration is configured,
 * got a server that believed it had no email provider and no payment keys.
 *
 * Order matters and is the whole point of this function. dotenv never overwrites a value
 * that is already set, so whichever file loads first wins per key. apps/api/.env is
 * therefore loaded first and keeps its values; the root file then supplies only the keys
 * that are genuinely missing, such as EMAIL_API_KEY.
 *
 * Loading the root file first, or overriding it, silently repoints DATABASE_URL at whatever
 * the root file names. In this repository that is a hosted Postgres, so the local API would
 * begin writing to it. That is not a configuration preference, it is data loss.
 *
 * Imported for its side effect by lib/prisma, which is the first thing in the process to
 * touch configuration. Doing it here rather than in index.ts matters: ES module imports are
 * hoisted above ordinary statements, so code in index.ts would run after its own imports.
 */
const apiEnv = path.resolve(__dirname, "..", "..", ".env");
const repoRootEnv = path.resolve(__dirname, "..", "..", "..", "..", ".env");

export function loadRepoEnv(): void {
  if (fs.existsSync(apiEnv)) {
    dotenv.config({ path: apiEnv, override: false });
  }
  if (fs.existsSync(repoRootEnv)) {
    dotenv.config({ path: repoRootEnv, override: false });
  }
}
