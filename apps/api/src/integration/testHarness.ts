import express from "express";
import request from "supertest";
import type { Express } from "express";
import { PrismaClient } from "@prisma/client";
import { authRouter } from "../routes/auth";
import { customerRouter } from "../routes/customers";
import { productRouter } from "../routes/products";
import { posRouter } from "../routes/pos";
import { expenseRouter } from "../routes/expenses";
import { inventoryRouter } from "../routes/inventory";
import { reportRouter } from "../routes/reports";
import { organizationRouter } from "../routes/organization";
import { userRouter } from "../routes/users";
import { roleRouter } from "../routes/roles";
import { cardPaymentRouter, paystackWebhookRouter } from "../routes/card-payments";
import { billingRouter } from "../routes/billing";
import { planRouter } from "../routes/plans";
import { platformRouter } from "../routes/platform";
import { errorHandler } from "../middleware/errorHandler";

/**
 * Exercises whole workflows over real HTTP against the real database.
 *
 * The unit suites mock Prisma, which proves the arithmetic but says nothing about
 * whether the routes are wired, whether authorization is actually applied, or whether
 * two tenants can see each other. Those are exactly the failures that cost a business
 * money, and none of them are visible from a mocked test.
 *
 * Every row created here carries the RUN_ID below and is removed afterwards, so a failed
 * run leaves a diagnosable trace rather than invisible litter in the data.
 *
 * This needs DATABASE_URL pointing at a database it may write to. It refuses to run
 * against a database whose name does not look like a test database, so a mistyped
 * DATABASE_URL cannot empty a real one.
 */
const prisma = new PrismaClient();
const app: Express = express();

/** Unique per run, so a leftover row is traceable and two runs never collide. */
export const RUN_ID = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL || "";
  let name = "";
  try {
    name = new URL(url).pathname.replace(/^\//, "");
  } catch {
    /* handled by the empty check below */
  }
  if (!name) throw new Error("DATABASE_URL is not set; integration tests cannot run");
  // Deliberately conservative. The cost of a false negative is a skipped suite; the
  // cost of a false positive is deleting a business's data.
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": it does not look like a ` +
        `test database. Point DATABASE_URL at a scratch database.`
    );
  }
}

/**
 * The same routers the server mounts, on a bare Express app.
 *
 * createApp() also wires Redis sessions, rate limiting and helmet. Depending on Redis
 * makes a test fail for reasons unrelated to what it is checking, and the behaviour
 * under test is authorization and data flow, not transport. The routes themselves are
 * identical, so the permission checks being exercised are the production ones.
 */
// The raw body is captured exactly as the server does it, because the Paystack webhook
// signature covers the bytes Paystack sent. A harness using plain express.json() leaves
// rawBody undefined, and the route then falls back to re-serializing the parsed body,
// which never reproduces the original bytes. A test written against that harness would
// pass while the real server behaved differently, which is the opposite of useful.
app.use(
  express.json({
    limit: "10mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/customers", customerRouter);
app.use("/api/v1/products", productRouter);
app.use("/api/v1/pos", posRouter);
app.use("/api/v1/expenses", expenseRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/reports", reportRouter);
app.use("/api/v1/card-payments", cardPaymentRouter);
// The webhook carries no session by design, so it is mounted on its own unauthenticated
// path rather than behind the card payment router's requireAuth.
app.use("/api/v1/webhooks", paystackWebhookRouter);
app.use("/api/v1/org", organizationRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/roles", roleRouter);
// The subscription surface is mounted here too, so entitlement enforcement is exercised over
// real HTTP rather than only against a mocked service.
app.use("/api/v1/billing", billingRouter);
app.use("/api/v1/plans", planRouter);
app.use("/api/v1/platform", platformRouter);

// The error handler is part of the behaviour under test, not optional decoration. Without
// it a ZodError falls through to Express's default handler and answers 500, so a test
// asserting "a bad amount is refused with 400" would fail against a perfectly correct
// server purely because the harness stopped one middleware short.
app.use(errorHandler);

export const testApp = app;
export const testPrisma = prisma;

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Registers a business and returns what is needed to act as it. */
export async function createTenant(label: string) {
  const email = `${RUN_ID}-${label}@example.test`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({
      organizationName: `${RUN_ID} ${label}`,
      name: `${label} Owner`,
      email,
      password: "KaziOS!Integration2026",
      country: "KE",
      currency: "KES",
      timezone: "Africa/Nairobi",
    });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Could not register ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    label,
    email,
    organizationId: res.body.data.organization.id,
    userId: res.body.data.user.id,
    token: res.body.data.token as string,
  };
}

/** Removes only rows carrying this run's marker, never anything else in the database. */
export async function cleanupRun(): Promise<void> {
  const orgs = await prisma.organization.findMany({
    where: { name: { startsWith: RUN_ID } },
    select: { id: true },
  });
  const orgIds = orgs.map(o => o.id);
  if (!orgIds.length) return;
  await prisma.$transaction(async tx => {
    await tx.journalLine.deleteMany({
      where: { journalEntry: { organizationId: { in: orgIds } } },
    });
    await tx.journalEntry.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.invoiceItem.deleteMany({ where: { invoice: { organizationId: { in: orgIds } } } });
    await tx.cardPayment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.cardPayment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.payment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.invoice.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.stockMovement.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.inventory.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.expense.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.expenseCategory.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.account.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.taxCategory.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.customer.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.product.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.warehouse.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.branch.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.setting.deleteMany({ where: { organizationId: { in: orgIds } } });
    // The subscription tables, in dependency order. Without these a leftover
    // EntitlementOverride or SubscriptionEvent would be found by a later run and quietly
    // change what that run is asserting.
    await tx.usageRecord.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.entitlementOverride.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.subscriptionPayment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.subscriptionEvent.deleteMany({
      where: { subscription: { organizationId: { in: orgIds } } },
    });
    await tx.subscription.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.userRole.deleteMany({ where: { user: { organizationId: { in: orgIds } } } });
    await tx.session.deleteMany({ where: { user: { organizationId: { in: orgIds } } } });
    await tx.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.role.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.user.deleteMany({ where: { organizationId: { in: orgIds } } });
    await tx.organization.deleteMany({ where: { id: { in: orgIds } } });
  });
}

export async function closeHarness(): Promise<void> {
  await cleanupRun();
  await prisma.$disconnect();
}
