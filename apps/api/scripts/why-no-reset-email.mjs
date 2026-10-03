// Shows why a password reset email is not going out, without guessing. The route
// deliberately answers the same way whether or not an account exists, so the reason is
// only visible here.
//
// Run with: node -r dotenv/config scripts/why-no-reset-email.mjs <email>
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const email = (process.argv[2] || "admin@kazios.dev").toLowerCase();

const user = await prisma.user.findUnique({
  where: { email },
  select: { id: true, email: true, name: true, status: true, organizationId: true },
});

if (!user) {
  console.log(`No user with the address ${email}.`);
  console.log("The route would answer as if it had sent a reset link, because it must not");
  console.log("reveal which addresses are registered.");
  process.exit(0);
}

console.log(`user   : ${user.email}`);
console.log(`name   : ${user.name}`);
console.log(`status : ${user.status}`);
console.log(`org    : ${user.organizationId}`);

if (user.status !== "ACTIVE") {
  console.log(`\nThis is why no email was sent: the route only issues a reset for an`);
  console.log(`ACTIVE account, and this one is ${user.status}.`);
}

const tokens = await prisma.passwordResetToken.findMany({
  where: { userId: user.id },
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { createdAt: true, expiresAt: true, usedAt: true },
});

console.log(`\nrecent reset tokens: ${tokens.length}`);
for (const token of tokens) {
  console.log(
    `  created ${token.createdAt.toISOString()}  expires ${token.expiresAt.toISOString()}` +
      (token.usedAt ? `  USED ${token.usedAt.toISOString()}` : "  unused")
  );
}
if (!tokens.length) {
  console.log("  none, which means issuePasswordReset was never reached for this account.");
}

await prisma.$disconnect();
