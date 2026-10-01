// Removes the junk left behind by the older smoke scripts, which wrote enormous
// placeholder invoices (100,000,000) and "Money Customer ..." rows. They are harmless
// in themselves but they destroy the revenue figure on the dashboard, so the demo data
// cannot be trusted until they are gone.
//
//   node apps/api/scripts/clean-legacy-smoke-data.cjs
//
// Only rows matching those known markers are touched. Anything without the marker is
// left alone, because it may be real data.
const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();
  const dryRun = !process.argv.includes("--apply");

  const customers = await prisma.customer.findMany({
    where: { OR: [{ name: { startsWith: "Money Customer" } }, { name: { startsWith: "Search Customer" } }] },
    select: { id: true, name: true },
  });
  const customerIds = customers.map((c) => c.id);

  // The placeholder invoices are the ones with an implausible total, not just the
  // prefix: anything a person would actually issue stays.
  const invoices = await prisma.invoice.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true, invoiceNumber: true, total: true },
  });

  console.log(`legacy customers : ${customers.length}`);
  console.log(`their invoices   : ${invoices.length}`);
  const absurd = invoices.filter((i) => i.total >= 1_000_000);
  console.log(`  of those, over 1,000,000: ${absurd.length}`);

  if (dryRun) {
    console.log("\nDry run. Re-run with --apply to remove them.");
    await prisma.$disconnect();
    return;
  }

  if (invoices.length) {
    const invoiceIds = invoices.map((i) => i.id);
    // The children go first. A foreign key refuses the parent delete rather than
    // cleaning up for us, and leaving orphans behind would quietly corrupt the
    // reports this cleanup exists to fix.
    const items = await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    const payments = await prisma.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    const movements = await prisma.stockMovement.deleteMany({ where: { reference: { in: invoiceIds } } });
    console.log(`  removed ${items.count} invoice lines, ${payments.count} payments`);
    const deleted = await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    console.log(`removed ${deleted.count} invoices`);
  }
  if (customerIds.length) {
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    console.log(`removed ${customerIds.length} customers`);
  }

  const agg = await prisma.invoice.aggregate({ _sum: { total: true }, _count: true });
  console.log(`\nremaining: ${agg._count} invoices, total ${agg._sum.total}`);
  await prisma.$disconnect();
}

main();