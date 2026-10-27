import { prisma } from "./src/lib/prisma";

async function main() {
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, slug: true, country: true, currency: true, status: true },
  });
  console.log("=== Organizations ===");
  for (const org of orgs) {
    const [products, customers, invoices, payments, expenses] = await Promise.all([
      prisma.product.count({ where: { organizationId: org.id } }),
      prisma.customer.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id } }),
      prisma.payment.count({ where: { organizationId: org.id } }),
      prisma.expense.count({ where: { organizationId: org.id } }),
    ]);
    console.log(`${org.name} (${org.slug}): ${products} products, ${customers} customers, ${invoices} invoices, ${payments} payments, ${expenses} expenses`);
  }

  const demoOrg = await prisma.organization.findUnique({ where: { slug: "demo-org" } });
  if (demoOrg) {
    console.log("\n=== Demo Organization Details ===");
    const products = await prisma.product.findMany({ where: { organizationId: demoOrg.id }, take: 5 });
    console.log("Sample products:", JSON.stringify(products, null, 2));
    const sales = await prisma.sale.count({ where: { organizationId: demoOrg.id } });
    console.log("Total sales:", sales);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
