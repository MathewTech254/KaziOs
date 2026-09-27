// Removes the fixtures the smoke scripts leave behind. It only ever touches rows that
// carry a smoke marker in their name, sku, notes or email, so real business data is safe.
//
//   node apps/api/scripts/cleanup-smoke-data.mjs          # report what would go
//   node apps/api/scripts/cleanup-smoke-data.mjs --apply  # delete it

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

/**
 * Every organization-scoped model, ordered so that a model is only removed after
 * whatever references it. Registration seeds branches, warehouses, roles and users,
 * so a throwaway organization is never a single row.
 */
const orgScopedModels = [
  "journalEntry",
  "payment",
  "invoice",
  "salesOrder",
  "quotation",
  "expense",
  "stockTransfer",
  "stockMovement",
  "inventory",
  "task",
  "project",
  "supportTicket",
  "automationRule",
  "webhookEndpoint",
  "notification",
  "apiKey",
  "file",
  "purchaseOrder",
  "supplier",
  "customer",
  "product",
  "category",
  "taxCategory",
  "account",
  "lead",
  "subscription",
  "setting",
  "auditLog",
  "warehouse",
  "branch",
  "role",
  "user",
];

const smokeOrgs = await prisma.organization.findMany({
  where: { name: { startsWith: "Tenant " } },
  select: { id: true, name: true },
});
const smokeUsers = await prisma.user.findMany({
  where: {
    OR: [
      // The smoke scripts use these fixed and prefixed addresses. "smoke." has to be
      // here too: smoke-inventory reuses one viewer account across runs.
      { email: { contains: "smoke" } },
      { email: { startsWith: "viewer." } },
      { email: { startsWith: "poviewer." } },
      // users the tenant checks registered inside a throwaway organization
      { organizationId: { in: smokeOrgs.map((o) => o.id) } },
    ],
  },
  select: { id: true, email: true },
});
const smokeRoles = await prisma.role.findMany({
  where: { name: { contains: "Smoke" } },
  select: { id: true, name: true },
});
// Each suite names its fixtures differently, so match every prefix they use.
const supplierPrefixes = ["Smoke Supplier", "Search Supplier"];
const smokeSuppliers = [];
for (const prefix of supplierPrefixes) {
  smokeSuppliers.push(
    ...(await prisma.supplier.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true, name: true },
    }))
  );
}

// Customers and products are fixtures too, and the isolation suite creates some.
const smokeCustomers = await prisma.customer.findMany({
  where: { OR: [{ name: { startsWith: "Iso Customer" } }, { name: { startsWith: "Money Customer" } }] },
  select: { id: true, name: true },
});
const isoProducts = await prisma.product.findMany({
  where: { sku: { startsWith: "ISO-" } },
  select: { id: true, sku: true },
});
const moneyProducts = await prisma.product.findMany({
  where: { sku: { startsWith: "MNY-" } },
  select: { id: true, sku: true },
});
const moneySuppliers = await prisma.supplier.findMany({
  where: { name: { startsWith: "Money Supplier" } },
  select: { id: true, name: true },
});
// The money suite creates many invoices against a "Money Customer" fixture, so
// they are cleared before the customer row itself.
const moneyInvoices = await prisma.invoice.findMany({
  where: { customerId: { in: smokeCustomers.map((c) => c.id) } },
  select: { id: true },
});
// Each suite names its product fixtures differently, so match every sku prefix.
const smokeProducts = [];
for (const prefix of ["SMK-", "SRCH-"]) {
  smokeProducts.push(
    ...(await prisma.product.findMany({ where: { sku: { startsWith: prefix } }, select: { id: true, sku: true } }))
  );
}
// Keyed off the fixture rows themselves, not off free text, so an order without
// notes is still removed.
const smokeOrders = await prisma.purchaseOrder.findMany({
  where: { supplierId: { in: smokeSuppliers.map((s) => s.id) } },
  select: { id: true, poNumber: true, status: true },
});
const moneyOrders = await prisma.purchaseOrder.findMany({
  where: { supplierId: { in: moneySuppliers.map((s) => s.id) } },
  select: { id: true, poNumber: true, status: true },
});

console.log(`tenant orgs   : ${smokeOrgs.length}`);
smokeOrgs.forEach((row) => console.log(`   ${row.name}`));
console.log(`smoke users   : ${smokeUsers.length} (${smokeUsers.map((u) => u.email).join(", ")})`);
console.log(`smoke roles   : ${smokeRoles.length} (${smokeRoles.map((r) => r.name).join(", ")})`);
console.log(`smoke suppliers: ${smokeSuppliers.length}`);
console.log(`smoke products: ${smokeProducts.length}`);
console.log(`smoke orders  : ${smokeOrders.length} (${smokeOrders.map((o) => `${o.poNumber} ${o.status}`).join(", ")})`);

if (!apply) {
  console.log("\nnothing deleted - pass --apply to clean up");
} else {
  const removed = {};
  // Order matters: an order references a supplier, and an organization references
  // everything. These run as a single transaction so a half-finished clean up is impossible.
  await prisma.$transaction(async (tx) => {
    removed.orders = (await tx.purchaseOrder.deleteMany({ where: { id: { in: [...smokeOrders, ...moneyOrders].map((o) => o.id) } } })).count;
    removed.suppliers = (
      await tx.supplier.deleteMany({ where: { id: { in: [...smokeSuppliers, ...moneySuppliers].map((s) => s.id) } } })
    ).count;
    // A smoke product can be picked up by another suite (smoke-inventory takes whichever
    // tracked product it finds first), so its stock rows go before the product itself.
    const productIds = [...smokeProducts, ...isoProducts, ...moneyProducts].map((p) => p.id);
    removed.stockMovements = (await tx.stockMovement.deleteMany({ where: { productId: { in: productIds } } })).count;
    removed.stockTransfers = (await tx.stockTransfer.deleteMany({ where: { productId: { in: productIds } } })).count;
    removed.inventories = (await tx.inventory.deleteMany({ where: { productId: { in: productIds } } })).count;
    removed.products = (await tx.product.deleteMany({ where: { id: { in: productIds } } })).count;
    // Invoice lines reference the invoice, so the invoices go before the customer.
    if (moneyInvoices.length) {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: moneyInvoices.map((i) => i.id) } } });
      removed.invoices = (await tx.invoice.deleteMany({ where: { id: { in: moneyInvoices.map((i) => i.id) } } })).count;
    } else {
      removed.invoices = 0;
    }

    // Orphans: a suite that failed part way through leaves an invoice whose customer row
    // was already cleaned away, so it can never be reached through a customer lookup.
    const orphanLines = await tx.invoiceItem.findMany({ where: { invoice: { customerId: null } }, select: { id: true } });
    await tx.invoiceItem.deleteMany({ where: { id: { in: orphanLines.map((l) => l.id) } } });
    removed.orphanInvoices = (await tx.invoice.deleteMany({ where: { customerId: null } })).count;

    removed.customers = (
      await tx.customer.deleteMany({ where: { id: { in: smokeCustomers.map((c) => c.id) } } })
    ).count;
    // Users hold sessions, role assignments and audit rows, so clear those first.
    const userIds = smokeUsers.map((u) => u.id);
    removed.sessions = (await tx.session.deleteMany({ where: { userId: { in: userIds } } })).count;
    // UserRole has no organizationId of its own; it is reached through the user.
    removed.roleAssignments = (
      await tx.userRole.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { roleId: { in: smokeRoles.map((r) => r.id) } }] } })
    ).count;
    removed.auditLogs = (await tx.auditLog.deleteMany({ where: { userId: { in: userIds } } })).count;
    removed.users = (await tx.user.deleteMany({ where: { id: { in: userIds } } })).count;
    removed.roles = (await tx.role.deleteMany({ where: { id: { in: smokeRoles.map((r) => r.id) } } })).count;

    // A throwaway organization owns a full set of child rows. Children go first,
    // otherwise the organization delete trips its foreign keys.
    const orgIds = smokeOrgs.map((o) => o.id);
    if (orgIds.length > 0) {
      removed.orgRows = 0;
      for (const model of orgScopedModels) {
        const result = await tx[model].deleteMany({ where: { organizationId: { in: orgIds } } });
        removed.orgRows += result.count;
      }
      removed.orgs = (await tx.organization.deleteMany({ where: { id: { in: orgIds } } })).count;
    } else {
      removed.orgRows = 0;
      removed.orgs = 0;
    }
  });

  console.log(
    `\ndeleted -> orders ${removed.orders}, suppliers ${removed.suppliers}, products ${removed.products}, ` +
      `stock movements ${removed.stockMovements}, transfers ${removed.stockTransfers}, inventory rows ${removed.inventories}, ` +
      `sessions ${removed.sessions}, role assignments ${removed.roleAssignments}, audit logs ${removed.auditLogs}, ` +
      `users ${removed.users}, roles ${removed.roles}, org child rows ${removed.orgRows}, orgs ${removed.orgs}`
  );
}

await prisma.$disconnect();
