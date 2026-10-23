import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";

/**
 * Loads the API's own .env first, then the repository root .env to fill the gaps,
 * with .env.production overriding both when the process is in production.
 *
 * The order below is the precedence order per key, because dotenv never
 * overwrites an already-set value:
 *
 * 1. .env.production (production only) — the production overrides. It must load
 *    first so it can override the other files rather than be silently ignored by
 *    them; it holds the hosted DATABASE_URL, which has to beat the local one in
 *    apps/api/.env.
 * 2. apps/api/.env — the API's own configuration (DATABASE_URL, SESSION_SECRET,
 *    API_PORT). It beats the root file because in this repository the root file
 *    names a hosted Postgres and the local file names a local one; loading the
 *    root file first would silently repoint the local API at hosted data.
 * 3. The repository root .env — the integration keys (M-PESA, Paystack live,
 *    email, SMS, AI, object storage) that every service shares. It loads last so
 *    it fills in the keys the API's own file does not define.
 *
 * dotenv never overwrites an already-set value, so whichever file loads first wins
 * per key.
 *
 * Paths are resolved from candidates rather than from __dirname alone, because
 * __dirname moves between the source layout (apps/api/src/lib) and the compiled
 * layout (apps/api/dist/lib). A path built with a fixed number of ".." worked for
 * one of them and pointed at apps/api/.env instead of the repository root .env for
 * the other, which silently left M-PESA unconfigured. Resolving every candidate
 * and keeping the first that exists is layout-independent.
 *
 * Imported for its side effect by lib/prisma, which is the first thing in the
 * process to touch configuration. Doing it here rather than in index.ts matters:
 * ES module imports are hoisted above ordinary statements, so code in index.ts
 * would run after its own imports.
 */

/** The API's own directory, whichever layout is running. */
function apiRootCandidates(base: string): string[] {
  const candidates: string[] = [];
  // Source layout: apps/api/src/lib -> apps/api. Compiled layout: apps/api/dist/lib -> apps/api.
  candidates.push(path.resolve(base, "..", ".."));
  // Defensive: if this file is ever moved deeper, walk up looking for the package.json
  // that belongs to the API.
  let dir = base;
  for (let i = 0; i < 6; i++) {
    dir = path.resolve(dir, "..");
    if (fs.existsSync(path.join(dir, "package.json"))) {
      candidates.push(dir);
      break;
    }
  }
  return candidates;
}

/**
 * The ancestors of the API directory, nearest first.
 *
 * The repository root is the one that declares npm workspaces, so the walk stops
 * there rather than climbing out of the repository entirely.
 */
function repoRootCandidates(apiRoot: string): string[] {
  const candidates: string[] = [];
  let dir = apiRoot;
  for (let i = 0; i < 6; i++) {
    dir = path.resolve(dir, "..");
    candidates.push(dir);
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) break;
      } catch {
        // A malformed package.json is not this function's problem; keep walking.
      }
    }
  }
  return candidates;
}

function firstExisting(candidates: string[], file: string): string | null {
  for (const dir of candidates) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * The env files this process should read, in load order (first wins per key).
 *
 * Exported so the resolution can be tested directly rather than inferred from
 * which variables happen to be set afterwards.
 */
export function resolveEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  base: string = __dirname
): string[] {
  const files: string[] = [];
  const apiRoots = apiRootCandidates(base);
  const apiRoot = apiRoots[0];

  // 1. The production overrides come first: they are meant to beat everything else.
  // Only in production, so a local run never inherits them.
  if (env.NODE_ENV === "production") {
    const production = firstExisting(apiRoots, ".env.production");
    if (production) files.push(production);
  }

  // 2. The API's own .env. This is the API's own configuration, and it beats the
  // repository root file.
  files.push(firstExisting(apiRoots, ".env") ?? path.join(apiRoot, ".env"));

  // 3. The repository root .env, which supplies the shared integration keys.
  const repoRoot = firstExisting(repoRootCandidates(apiRoot), ".env");
  if (repoRoot && !files.includes(repoRoot)) files.push(repoRoot);

  // The working directory is checked last: it only matters when the API is started
  // from somewhere else entirely (a host that sets cwd to /app), and it must never
  // outrank the API's own file.
  const cwdEnv = path.join(cwd, ".env");
  if (fs.existsSync(cwdEnv) && !files.includes(cwdEnv)) files.push(cwdEnv);

  return files;
}

export function loadRepoEnv(): void {
  for (const file of resolveEnvFiles()) {
    dotenv.config({ path: file, override: false });
  }
}
