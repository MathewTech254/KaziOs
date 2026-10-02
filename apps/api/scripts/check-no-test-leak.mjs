// One-off guard: proves the integration suite cannot leave rows in the development
// database. Run against .env (the dev URL), never against kazios_test.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const leakedOrgs = await prisma.organization.count({ where: { name: { startsWith: "itest-" } } });
const orgs = await prisma.organization.count();
const invoices = await prisma.invoice.count();
const expenses = await prisma.expense.count().catch(() => 0);

console.log("organizations:", orgs);
console.log("invoices:", invoices);
console.log("expenses:", expenses);
console.log("LEAKED TEST ORGANIZATIONS:", leakedOrgs);

await prisma.$disconnect();
process.exit(leakedOrgs === 0 ? 0 : 1);
