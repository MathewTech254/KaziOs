import { Worker, Queue } from "bullmq";
import Redis from "ioredis";
import { prisma, reconcileSubscriptions } from "@kazios/api";
import { QUEUE_NAMES } from "@kazios/types";

const connection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const queues = {
  notifications: new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection }),
  automations: new Queue(QUEUE_NAMES.AUTOMATIONS, { connection }),
  reports: new Queue(QUEUE_NAMES.REPORTS, { connection }),
  invoiceOverdue: new Queue(QUEUE_NAMES.INVOICE_OVERDUE, { connection }),
  stockCheck: new Queue(QUEUE_NAMES.STOCK_CHECK, { connection }),
  subscriptions: new Queue(QUEUE_NAMES.SUBSCRIPTIONS, { connection }),
};

/**
 * How often the background sweeps run.
 *
 * These are deliberately modest. Nothing here needs to happen to the second: an invoice
 * going overdue is discovered by the next run, and a stock level is noticed the moment
 * a sale or adjustment moves it. The sweep is the safety net for shops that never open
 * the till, not the primary path.
 */
const OVERDUE_EVERY_MS = Number(process.env.OVERDUE_SWEEP_MS || 60 * 60 * 1000);
const STOCK_EVERY_MS = Number(process.env.STOCK_SWEEP_MS || 15 * 60 * 1000);

/**
 * How often subscriptions are reconciled.
 *
 * Hourly, alongside the invoice sweep. This is not what makes the product behave correctly:
 * the API derives each subscription's real status from the clock on every request, so a
 * business whose card failed is treated correctly the moment it happens whether or not this
 * has run. What the sweep is for is writing those transitions down, so the admin area and
 * the ledger tell the same story as the checks the product runs, and so a long outage of
 * this worker cannot leave a stale "ACTIVE" sitting in a support conversation.
 */
const SUBSCRIPTION_EVERY_MS = Number(process.env.SUBSCRIPTION_SWEEP_MS || 60 * 60 * 1000);

async function sendNotification(job: any) {
  const { organizationId, userId, channel, type, title, body } = job.data;

  // A notification belongs to a person. Without one there is nobody to show it to, and
  // the column is not nullable, so the job is discarded rather than failing forever.
  if (!userId) {
    console.warn(`Notification job ${job.id} had no recipient and was skipped`);
    return;
  }

  await prisma.notification.create({
    data: {
      organizationId,
      userId,
      channel: channel || "in_app",
      type: type || "info",
      title,
      body,
      status: "SENT",
    },
  });
  console.log(`Notification sent for job ${job.id}`);
}

async function executeAutomation(job: any) {
  const { automationId, trigger, payload } = job.data;
  const automation = await prisma.automationRule.findUnique({ where: { id: automationId } });
  if (!automation?.isActive) return;

  await prisma.automationExecution.create({
    data: { automationId, status: "SUCCESS", result: { trigger, payload } },
  });
  console.log(`Automation executed: ${automationId}`);
}

/**
 * Marks invoices past their due date as overdue and tells whoever owns the books.
 *
 * A silent status change is the failure this replaces: a customer who has not paid
 * simply stops appearing in any list, and the business loses the money without ever
 * being told. The alert is deduplicated per invoice, so a customer who stays overdue
 * is raised once rather than on every hourly run.
 */
async function checkOverdueInvoices() {
  const now = new Date();
  const overdue = await prisma.invoice.findMany({
    where: {
      status: "SENT",
      dueDate: { lt: now },
    },
    select: { id: true, invoiceNumber: true, total: true, currency: true, organizationId: true },
  });

  for (const invoice of overdue) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "OVERDUE" } });

    const holders = await prisma.userRole.findMany({
      where: {
        user: { organizationId: invoice.organizationId, status: "ACTIVE" },
        OR: [
          { role: { permissions: { has: "reports.view" } } },
          { role: { permissions: { has: "*" } } },
        ],
      },
      select: { userId: true },
    });

    const userIds = Array.from(new Set(holders.map(row => row.userId)));
    if (!userIds.length) continue;

    // The dedupe key is what stops an invoice that stays unpaid from raising a fresh
    // alert every hour for as long as the customer ignores it.
    const alreadyRaised = await prisma.notification.findFirst({
      where: { dedupeKey: `invoice-overdue:${invoice.id}`, userId: { in: userIds }, readAt: null },
      select: { id: true },
    });
    if (alreadyRaised) continue;

    await prisma.notification.createMany({
      data: userIds.map(userId => ({
        organizationId: invoice.organizationId,
        userId,
        channel: "in_app",
        type: "warning",
        title: "Invoice overdue",
        body: `${invoice.invoiceNumber} (${invoice.currency} ${invoice.total.toFixed(2)}) passed its due date.`,
        link: "/dashboard/invoices",
        dedupeKey: `invoice-overdue:${invoice.id}`,
        status: "SENT",
      })),
    });

    console.log(`Marked ${invoice.invoiceNumber} overdue and alerted ${userIds.length} user(s)`);
  }
}

/**
 * Sweeps every organization for stock that has fallen to its reorder level.
 *
 * The sweep exists because stock can fall without a sale: an adjustment, or a transfer
 * out of a warehouse that then sits idle. Without this, those shops would never hear
 * about it. The same deduplication applies, so a product that stays low is raised once.
 */
async function checkStock() {
  const organizations = await prisma.organization.findMany({ select: { id: true } });

  for (const organization of organizations) {
    const levels = await prisma.inventory.findMany({
      where: { organizationId: organization.id },
      include: { product: true, warehouse: true },
    });

    for (const level of levels) {
      const { product, warehouse, quantity, reserved } = level;
      if (!product.trackStock || product.minStock <= 0) continue;

      const available = Math.max(0, quantity - reserved);
      if (available > product.minStock) continue;

      const holders = await prisma.userRole.findMany({
        where: {
          user: { organizationId: organization.id, status: "ACTIVE" },
          OR: [
            { role: { permissions: { has: "inventory.view" } } },
            { role: { permissions: { has: "*" } } },
          ],
        },
        select: { userId: true },
      });

      const userIds = Array.from(new Set(holders.map(row => row.userId)));
      if (!userIds.length) continue;

      const dedupeKey = `low-stock:${product.id}:${warehouse.id}`;
      const alreadyRaised = await prisma.notification.findFirst({
        where: { dedupeKey, userId: { in: userIds }, readAt: null },
        select: { id: true },
      });
      if (alreadyRaised) continue;

      await prisma.notification.createMany({
        data: userIds.map(userId => ({
          organizationId: organization.id,
          userId,
          channel: "in_app",
          type: available <= 0 ? "error" : "warning",
          title: available <= 0 ? "Out of stock" : "Low stock",
          body:
            available <= 0
              ? `${product.name} has sold out in ${warehouse.name}.`
              : `${product.name} is down to ${available} in ${warehouse.name} (reorder at ${product.minStock}).`,
          link: "/inventory",
          dedupeKey,
          status: "SENT",
        })),
      });

      console.log(`Raised low stock alert for ${product.name} in ${warehouse.name}`);
    }
  }
}

/**
 * The subscription sweep, as a BullMQ job.
 *
 * A thin wrapper rather than passing `reconcileSubscriptions` straight in, because that
 * function takes a clock and BullMQ passes a job. The two are both called `now`-ish and
 * swapping them by accident would reconcile against a job object, which reads as a date
 * only in the sense that it does not throw immediately.
 */
async function reconcileSubscriptionJobs() {
  const summary = await reconcileSubscriptions(new Date());
  if (summary.expired || summary.pastDue || summary.planChanges) {
    console.log(
      `Subscription sweep: ${summary.expired} expired, ${summary.pastDue} entered grace, ${summary.planChanges} plan changes applied`
    );
  }
  return summary;
}

async function main() {
  new Worker(QUEUE_NAMES.NOTIFICATIONS, sendNotification, { connection });
  new Worker(QUEUE_NAMES.AUTOMATIONS, executeAutomation, { connection });

  // The sweeps now carry no organization: each run covers every tenant at once. That
  // avoids a job per shop per interval, which is what made the old design unusable at
  // any real number of customers.
  new Worker(QUEUE_NAMES.INVOICE_OVERDUE, checkOverdueInvoices, { connection });
  new Worker(QUEUE_NAMES.STOCK_CHECK, checkStock, { connection });
  new Worker(QUEUE_NAMES.SUBSCRIPTIONS, reconcileSubscriptionJobs, { connection });

  // Registering the repeat is what makes these queues run at all. Without it the
  // workers above sit waiting on a queue nothing ever writes to.
  await queues.invoiceOverdue.add(
    "sweep",
    {},
    { repeat: { every: OVERDUE_EVERY_MS }, jobId: "sweep" }
  );
  await queues.stockCheck.add("sweep", {}, { repeat: { every: STOCK_EVERY_MS }, jobId: "sweep" });
  await queues.subscriptions.add(
    "sweep",
    {},
    { repeat: { every: SUBSCRIPTION_EVERY_MS }, jobId: "sweep" }
  );

  console.log(
    `KaziOS worker started (overdue every ${OVERDUE_EVERY_MS}ms, stock every ${STOCK_EVERY_MS}ms, subscriptions every ${SUBSCRIPTION_EVERY_MS}ms)`
  );
}

main().catch(err => {
  console.error("Worker failed:", err);
  process.exit(1);
});
