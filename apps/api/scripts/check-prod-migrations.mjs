// Read only check that the migrations in this repository have actually been applied to
// the database this URL names. Reports the tables the most recent features need, without
// writing anything.
//
// Usage: node scripts/check-prod-migrations.mjs "<DATABASE_URL>"
import { PrismaClient } from "@prisma/client";

const url = process.argv[2];
if (!url) {
  console.error("Pass the database URL to inspect.");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Tables added by the features in this repository. A route can be deployed and still
// fail on every request if the table behind it was never created. The billing
// tables are listed explicitly because that exact outage happened: the API was
// live on Render while Neon had never received the subscription migrations, so
// GET /api/v1/plans failed on every request with P2021 on public.Plan.
const REQUIRED = [
  { table: '"Expense"', why: "expenses" },
  { table: '"ExpenseCategory"', why: "expenses" },
  { table: '"CardPayment"', why: "card payments" },
  { table: '"PasswordResetToken"', why: "password reset" },
  { table: '"AuditLog"', why: "audit trail" },
  { table: '"Inventory"', why: "stock ledger" },
  { table: '"Plan"', why: "subscriptions (GET /api/v1/plans)" },
  { table: '"PlanPrice"', why: "subscriptions" },
  { table: '"Feature"', why: "subscriptions" },
  { table: '"PlanFeature"', why: "subscriptions" },
  { table: '"PlanLimit"', why: "subscriptions" },
  { table: '"Subscription"', why: "subscriptions" },
  { table: '"SubscriptionEvent"', why: "subscriptions" },
  { table: '"SubscriptionPayment"', why: "subscriptions" },
  { table: '"UsageRecord"', why: "usage metering" },
  { table: '"EntitlementOverride"', why: "subscriptions" },
  { table: '"PlatformAdmin"', why: "platform billing admin" },
];

let missing = 0;

try {
  for (const { table, why } of REQUIRED) {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      table.replace(/"/g, "")
    );
    const present = rows.length > 0;
    if (!present) missing++;
    console.log(`${present ? "present" : "MISSING"}  ${table.padEnd(22)} ${why}`);
  }

  const applied = await prisma.$queryRawUnsafe(
    "SELECT migration_name, finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at"
  );
  console.log(`\napplied migrations: ${applied.length}`);
  for (const row of applied.slice(-6)) console.log(`  ${row.migration_name}`);
} catch (err) {
  console.error(`Could not read that database: ${err.message}`);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

process.exit(missing === 0 ? 0 : 1);
