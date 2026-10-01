import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: "admin@kazios.dev" } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { status: "ACTIVE", passwordHash: await hashPassword("admin123") },
    });
    console.log("Seed already applied; demo account reactivated");
    return existing.organizationId;
  }

  const passwordHash = await hashPassword("admin123");

  const org = await prisma.organization.create({
    data: {
      name: "Demo Organization",
      slug: "demo-org",
      country: "KE",
      currency: "KES",
      timezone: "Africa/Nairobi",
    },
  });

  const user = await prisma.user.create({
    data: {
      email: "admin@kazios.dev",
      passwordHash,
      name: "Admin",
      organizationId: org.id,
      status: "ACTIVE",
    },
  });

  const ownerRole = await prisma.role.create({
    data: { name: "Owner", type: "OWNER", organizationId: org.id, permissions: ["*"] },
  });

  await prisma.userRole.create({ data: { userId: user.id, roleId: ownerRole.id } });

  await prisma.branch.create({
    data: { name: "Main Branch", code: "MAIN", organizationId: org.id, isMain: true },
  });

  await prisma.warehouse.create({
    data: { name: "Main Warehouse", code: "WH-01", organizationId: org.id },
  });

  await prisma.account.createMany({
    data: [
      { code: "1000", name: "Cash", type: "ASSET", organizationId: org.id, isSystem: true },
      { code: "1100", name: "Bank", type: "ASSET", organizationId: org.id, isSystem: true },
      {
        code: "2000",
        name: "Accounts Payable",
        type: "LIABILITY",
        organizationId: org.id,
        isSystem: true,
      },
      {
        code: "4000",
        name: "Sales Revenue",
        type: "REVENUE",
        organizationId: org.id,
        isSystem: true,
      },
      {
        code: "5000",
        name: "Cost of Goods Sold",
        type: "EXPENSE",
        organizationId: org.id,
        isSystem: true,
      },
      {
        code: "5100",
        name: "General Expenses",
        type: "EXPENSE",
        organizationId: org.id,
        isSystem: true,
      },
    ],
  });

  await prisma.taxCategory.createMany({
    data: [
      { name: "VAT Standard", rate: 16, mode: "EXCLUSIVE", organizationId: org.id },
      { name: "Zero Rated", rate: 0, mode: "EXCLUSIVE", organizationId: org.id },
      { name: "Exempt", rate: 0, mode: "EXCLUSIVE", organizationId: org.id },
    ],
  });

  console.log("Seed complete: admin@kazios.dev / admin123");
  return org.id;
}

async function seedDemoData(orgId: string) {
  const hasInvoices = await prisma.invoice.count({ where: { organizationId: orgId } });
  if (hasInvoices > 0) return;

  const warehouse = await prisma.warehouse.findFirst({ where: { organizationId: orgId } });
  const branch = await prisma.branch.findFirst({ where: { organizationId: orgId } });
  if (!warehouse || !branch) return;

  await prisma.product.createMany({
    data: [
      {
        name: "Maize Flour (2kg)",
        sku: "MAIZ-001",
        costPrice: 120,
        sellingPrice: 180,
        minStock: 20,
        productType: "PHYSICAL",
        organizationId: orgId,
      },
      {
        name: "Cooking Oil (500ml)",
        sku: "OIL-002",
        costPrice: 80,
        sellingPrice: 130,
        minStock: 15,
        productType: "PHYSICAL",
        organizationId: orgId,
      },
      {
        name: "Sugar (1kg)",
        sku: "SUG-003",
        costPrice: 90,
        sellingPrice: 140,
        minStock: 25,
        productType: "PHYSICAL",
        organizationId: orgId,
      },
      {
        name: "Office Printer Paper",
        sku: "PAP-004",
        costPrice: 2400,
        sellingPrice: 3200,
        minStock: 5,
        productType: "PHYSICAL",
        organizationId: orgId,
      },
      {
        name: "Web Hosting Service",
        sku: "WEB-005",
        costPrice: 0,
        sellingPrice: 1500,
        minStock: 0,
        productType: "SERVICE",
        organizationId: orgId,
      },
    ],
  });

  const createdProducts = await prisma.product.findMany({ where: { organizationId: orgId } });
  await prisma.customer.createMany({
    data: [
      {
        name: "Acme Ltd",
        email: "acme@example.com",
        phone: "+254712345678",
        customerType: "BUSINESS",
        organizationId: orgId,
      },
      {
        name: "Mwangi Store",
        email: "mwangi@example.com",
        phone: "+254722345678",
        customerType: "INDIVIDUAL",
        organizationId: orgId,
      },
      {
        name: "Nairobi Cafe",
        email: "cafe@example.com",
        phone: "+254733345678",
        customerType: "BUSINESS",
        organizationId: orgId,
      },
    ],
  });

  const createdCustomers = await prisma.customer.findMany({ where: { organizationId: orgId } });

  await prisma.inventory.createMany({
    data: createdProducts.map((p, i) => ({
      productId: p.id,
      warehouseId: warehouse.id,
      quantity: [50, 30, 40, 8, 100][i] || 10,
      reserved: 0,
      organizationId: orgId,
    })),
  });

  const now = new Date();
  for (let d = 0; d < 14; d++) {
    const issueDate = new Date(now);
    issueDate.setDate(issueDate.getDate() - d);
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + 14);
    const cust = createdCustomers[d % createdCustomers.length];
    const items = [
      createdProducts[d % createdProducts.length],
      createdProducts[(d + 1) % createdProducts.length],
    ];
    const total = items.reduce((s, p) => s + p.sellingPrice * ((d % 3) + 1), 0);
    const tax = total * 0.16;
    const status = d < 3 ? "PAID" : d < 7 ? "SENT" : d < 10 ? "PARTIALLY_PAID" : "DRAFT";
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${1000 + d}`,
        organizationId: orgId,
        customerId: cust.id,
        branchId: branch.id,
        issueDate,
        dueDate,
        subtotal: total,
        taxTotal: tax,
        discountTotal: 0,
        total: total + tax,
        currency: "KES",
        status,
        paidAmount:
          status === "PAID" ? total + tax : status === "PARTIALLY_PAID" ? (total + tax) * 0.5 : 0,
      },
    });
    if (status === "PAID" || status === "PARTIALLY_PAID") {
      await prisma.payment.create({
        data: {
          reference: `PAY-${1000 + d}`,
          organizationId: orgId,
          amount: status === "PAID" ? total + tax : (total + tax) * 0.5,
          currency: "KES",
          provider: "MPESA",
          methodType: "MOBILE_MONEY",
          status: "SUCCESS",
          invoiceId: inv.id,
          customerId: cust.id,
          branchId: branch.id,
          paidAt: issueDate,
        },
      });
    }
  }

  await prisma.expense.createMany({
    data: [
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: "Rent",
        vendorName: "Landlord Ltd",
        amount: 45000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 5),
        paymentMethod: "BANK_TRANSFER",
      },
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: "Utilities",
        vendorName: "Power Co",
        amount: 12000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 10),
        paymentMethod: "BANK_TRANSFER",
      },
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: "Salaries",
        vendorName: "Payroll Services",
        amount: 120000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 25),
        paymentMethod: "BANK_TRANSFER",
      },
    ],
  });

  console.log("Demo data seeded");
}

main()
  .then(orgId => seedDemoData(orgId))
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
