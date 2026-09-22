import { Worker, Queue } from "bullmq";
import Redis from "ioredis";
import { prisma } from "@kazios/api";
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
};

async function sendNotification(job: any) {
  const { organizationId, userId, channel, type, title, body } = job.data;
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
  if (!automation || !automation.isActive) return;

  await prisma.automationExecution.create({
    data: { automationId, status: "SUCCESS", result: { trigger, payload } },
  });
  console.log(`Automation executed: ${automationId}`);
}

async function checkOverdueInvoices(job: any) {
  const { organizationId } = job.data;
  const overdue = await prisma.invoice.updateMany({
    where: {
      organizationId,
      status: "SENT",
      dueDate: { lt: new Date() },
    },
    data: { status: "OVERDUE" },
  });
  console.log(`Marked ${overdue.count} invoices overdue for org ${organizationId}`);
}

async function checkStock(job: any) {
  const { organizationId } = job.data;
  const lowStock = await prisma.inventory.findMany({
    where: { product: { organizationId } },
    include: { product: true, warehouse: true },
  });
  for (const inv of lowStock) {
    if (inv.product.minStock > 0 && inv.quantity <= inv.product.minStock) {
      await queues.notifications.add("stock-low", {
        organizationId,
        channel: "in_app",
        type: "warning",
        title: "Low Stock Alert",
        body: `${inv.product.name} is low in ${inv.warehouse.name} (${inv.quantity} remaining)`,
      });
    }
  }
}

async function main() {
  new Worker(QUEUE_NAMES.NOTIFICATIONS, sendNotification, { connection });
  new Worker(QUEUE_NAMES.AUTOMATIONS, executeAutomation, { connection });
  new Worker(QUEUE_NAMES.INVOICE_OVERDUE, checkOverdueInvoices, { connection });
  new Worker(QUEUE_NAMES.STOCK_CHECK, checkStock, { connection });

  console.log("KaziOS worker started");
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});