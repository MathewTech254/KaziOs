// Scrubs credentials out of audit rows that were written before the audit middleware
// stopped storing raw request bodies.
//
//   node apps/api/scripts/scrub-audit-secrets.mjs          # report what would change
//   node apps/api/scripts/scrub-audit-secrets.mjs --apply  # rewrite the rows
//
// Fixing the middleware stops new leaks but does nothing about the passwords already
// sitting in an AuditLog table, in whatever backups contain that table, and in anything
// that has since exported it. This rewrites the stored JSON in place, keeping every
// legitimate field so the audit trail stays usable.
//
// Only the credential bearing keys are replaced. The action, the path, the actor, the
// entity and the timestamp are all left exactly as they were, because an audit log with
// the evidence removed is not an audit log.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

/**
 * Kept in step with SENSITIVE_KEYS in apps/api/src/middleware/audit.ts. The two have to
 * agree: a key redacted at write time but not at scrub time would still be sitting in
 * the database, and the reverse would corrupt a harmless field.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "confirmpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "secret",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
  "setcookie",
  "signature",
]);

const MAX_DEPTH = 8;

/** Returns a count of the credentials replaced, without mutating the input. */
function countSecrets(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countSecrets(item, depth + 1), 0);
  }
  let found = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && entry !== "[redacted]") found += 1;
    else found += countSecrets(entry, depth + 1);
  }
  return found;
}

function scrub(value, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : scrub(entry, depth + 1);
  }
  return output;
}

async function main() {
  // Every row is inspected rather than filtered in SQL: the credentials are buried
  // inside a JSON column and a text search over it is neither reliable nor indexable.
  const rows = await prisma.auditLog.findMany({ select: { id: true, changes: true } });

  const affected = rows
    .map(row => ({ id: row.id, found: countSecrets(row.changes) }))
    .filter(row => row.found > 0);

  const totalSecrets = affected.reduce((sum, row) => sum + row.found, 0);

  console.log(`audit rows scanned : ${rows.length}`);
  console.log(`rows holding secrets: ${affected.length}`);
  console.log(`secrets found      : ${totalSecrets}`);

  if (!affected.length) {
    console.log("\nNothing to do. No stored audit row contains a credential.");
    return;
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to rewrite these rows.");
    return;
  }

  let updated = 0;
  for (const row of affected) {
    const record = await prisma.auditLog.findUnique({ where: { id: row.id } });
    if (!record) continue;
    await prisma.auditLog.update({
      where: { id: row.id },
      data: { changes: scrub(record.changes) },
    });
    updated += 1;
  }

  console.log(`\nrows rewritten     : ${updated}`);
  console.log(
    "\nEvery affected account should still be told to rotate its password: a credential\n" +
      "that was stored in cleartext must be assumed to have been read."
  );
}

main()
  .catch(err => {
    console.error("Scrub failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
