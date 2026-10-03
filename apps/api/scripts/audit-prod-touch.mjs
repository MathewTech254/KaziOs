// Read only audit of a misdirected connection. Prints what a stray write would have left
// behind. Makes no changes of any kind.
//
// Usage: node scripts/audit-prod-touch.mjs "<DATABASE_URL>"
import { PrismaClient } from "@prisma/client";

const url = process.argv[2];
if (!url) {
  console.error("Pass the database URL to inspect. Nothing is changed either way.");
  process.exit(1);
}

if (/localhost|127\.0\.0\.1/.test(url)) {
  console.log("That is a local database, not a hosted one. Nothing to audit.");
  process.exit(0);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  const [orgs, users, tokens, invoices, recentTokens] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.passwordResetToken.count(),
    prisma.invoice.count(),
    prisma.passwordResetToken.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true, usedAt: true, user: { select: { email: true } } },
    }),
  ]);

  console.log("organizations :", orgs);
  console.log("users         :", users);
  console.log("invoices      :", invoices);
  console.log("reset tokens  :", tokens);
  console.log("\nmost recent reset tokens:");
  for (const token of recentTokens) {
    console.log(
      `  ${token.createdAt.toISOString()}  ${token.user?.email ?? "(no user)"}` +
        (token.usedAt ? "  USED" : "  unused")
    );
  }
  if (!recentTokens.length) console.log("  none");
} catch (err) {
  console.error(`Could not read that database: ${err.message}`);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
