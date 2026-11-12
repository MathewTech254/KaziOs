import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth";
import { generateId } from "../lib/utils";
import { DEFAULT_EXPENSE_CATEGORIES } from "../lib/expenseCategories";

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

  // The demo business needs a subscription like any other, or every entitlement check
  // against it falls back to Community with no limits and the demo quietly stops
  // demonstrating the limit refusals that make the Billing tab worth looking at.
  const defaultPlan = await prisma.plan.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (defaultPlan) {
    await prisma.subscription.create({
      data: {
        organizationId: org.id,
        planId: defaultPlan.id,
        status: "ACTIVE",
        billingInterval: "monthly",
      },
    });
    await prisma.organization.update({
      where: { id: org.id },
      data: { planId: defaultPlan.id },
    });
  } else {
    console.warn(
      "No default plan found. The demo organization will fall back to Community " +
        "entitlements until the plan catalogue is migrated in."
    );
  }

  console.log("Seed complete: admin@kazios.dev / admin123");
  return org.id;
}

async function seedDemoData(orgId: string) {
  const hasInvoices = await prisma.invoice.count({ where: { organizationId: orgId } });
  if (hasInvoices === 0) await seedDemoTradingData(orgId);
  await seedDemoExpenses(orgId);
  console.log("Demo data seeded");
}

/** Products, customers, stock, invoices and payments: guarded so a re-run cannot duplicate them. */
async function seedDemoTradingData(orgId: string) {
  const warehouse = await prisma.warehouse.findFirst({ where: { organizationId: orgId } });
  const branch = await prisma.branch.findFirst({ where: { organizationId: orgId } });
  if (!warehouse || !branch) return;

  // --- Liquor store products: beers, spirits, wines, soft drinks, mixers ---
  // KES prices, crate (24) and carton (12) pack units, base unit = bottle.
  const products = [
    // Beers (crate = 24 bottles)
    {
      name: "Tusker Lager",
      sku: "LQR-BEER-001",
      barcode: "6001000001001",
      size: "500ml",
      category: "beer",
      costPrice: 180,
      sellingPrice: 300,
      minStock: 48,
      reorderPoint: 24,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 120, // 5 crates
    },
    {
      name: "Whitecap Lager",
      sku: "LQR-BEER-002",
      barcode: "6001000001002",
      size: "500ml",
      category: "beer",
      costPrice: 170,
      sellingPrice: 280,
      minStock: 48,
      reorderPoint: 24,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 24, // low stock (1 crate)
    },
    {
      name: "Guinness Foreign Extra",
      sku: "LQR-BEER-003",
      barcode: "6001000001003",
      size: "330ml",
      category: "beer",
      costPrice: 220,
      sellingPrice: 380,
      minStock: 24,
      reorderPoint: 12,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 0, // out of stock
    },
    // Spirits (bottle base, carton = 12 bottles)
    {
      name: "Jameson Irish Whiskey",
      sku: "LQR-SPIRIT-001",
      barcode: "6001000002001",
      size: "750ml",
      category: "spirits",
      costPrice: 2400,
      sellingPrice: 3200,
      minStock: 12,
      reorderPoint: 6,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "carton", factorToBase: 12, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 36, // 3 cartons
    },
    {
      name: "Smirnoff Vodka",
      sku: "LQR-SPIRIT-002",
      barcode: "6001000002002",
      size: "750ml",
      category: "spirits",
      costPrice: 1800,
      sellingPrice: 2500,
      minStock: 12,
      reorderPoint: 6,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "carton", factorToBase: 12, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 0, // out of stock
    },
    {
      name: "Johnnie Walker Red Label",
      sku: "LQR-SPIRIT-003",
      barcode: "6001000002003",
      size: "750ml",
      category: "spirits",
      costPrice: 3200,
      sellingPrice: 4200,
      minStock: 6,
      reorderPoint: 3,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "carton", factorToBase: 12, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 6, // at reorder point
    },
    // Wines
    {
      name: "Seven Sisters Red Wine",
      sku: "LQR-WINE-001",
      barcode: "6001000003001",
      size: "750ml",
      category: "wine",
      costPrice: 1400,
      sellingPrice: 1900,
      minStock: 12,
      reorderPoint: 6,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "carton", factorToBase: 12, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 24, // 2 cartons
    },
    {
      name: "Seven Sisters White Wine",
      sku: "LQR-WINE-002",
      barcode: "6001000003002",
      size: "750ml",
      category: "wine",
      costPrice: 1400,
      sellingPrice: 1900,
      minStock: 12,
      reorderPoint: 6,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "carton", factorToBase: 12, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 12, // 1 carton
    },
    // Soft drinks and mixers (crate = 24 bottles)
    {
      name: "Coca-Cola",
      sku: "LQR-SODA-001",
      barcode: "6001000004001",
      size: "300ml",
      category: "soft drinks",
      costPrice: 40,
      sellingPrice: 80,
      minStock: 48,
      reorderPoint: 24,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 72, // 3 crates
    },
    {
      name: "Sprite",
      sku: "LQR-SODA-002",
      barcode: "6001000004002",
      size: "300ml",
      category: "soft drinks",
      costPrice: 40,
      sellingPrice: 80,
      minStock: 48,
      reorderPoint: 24,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 0, // out of stock
    },
    {
      name: "Club Soda",
      sku: "LQR-MIXER-001",
      barcode: "6001000005001",
      size: "300ml",
      category: "other",
      costPrice: 30,
      sellingPrice: 60,
      minStock: 24,
      reorderPoint: 12,
      productType: "PHYSICAL",
      organizationId: orgId,
      units: [
        { name: "bottle", factorToBase: 1, isDefaultSaleUnit: true, isDefaultPurchaseUnit: false },
        { name: "crate", factorToBase: 24, isDefaultSaleUnit: false, isDefaultPurchaseUnit: true },
      ],
      stock: 48, // 2 crates
    },
  ];

  // Create products with their units
  const createdProducts: any[] = [];
  for (const p of products) {
    const product = await prisma.product.create({
      data: {
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        size: p.size,
        category: p.category,
        costPrice: p.costPrice,
        sellingPrice: p.sellingPrice,
        minStock: p.minStock,
        reorderPoint: p.reorderPoint,
        isActive: true,
        productType: p.productType,
        organizationId: orgId,
        productUnits: {
          create: p.units.map(u => ({
            ...u,
            organization: { connect: { id: orgId } },
          })),
        },
      },
      include: { productUnits: true },
    });
    createdProducts.push(product);

    await prisma.inventory.create({
      data: {
        productId: product.id,
        warehouseId: warehouse.id,
        quantity: p.stock,
        reserved: 0,
        organizationId: orgId,
      },
    });
  }

  // --- Users: 2 attendants, 1 owner (already created in main seed) ---
  const attendantRole = await prisma.role.create({
    data: {
      name: "Attendant",
      type: "ATTENDANT",
      organizationId: orgId,
      permissions: ["pos.sale", "products.view", "inventory.view"],
    },
  });

  const attendant1 = await prisma.user.create({
    data: {
      email: "attendant1@kazios.dev",
      passwordHash: await hashPassword("attendant123"),
      name: "Grace Wanjiku",
      organizationId: orgId,
      status: "ACTIVE",
    },
  });
  await prisma.userRole.create({ data: { userId: attendant1.id, roleId: attendantRole.id } });

  const attendant2 = await prisma.user.create({
    data: {
      email: "attendant2@kazios.dev",
      passwordHash: await hashPassword("attendant123"),
      name: "Peter Otieno",
      organizationId: orgId,
      status: "ACTIVE",
    },
  });
  await prisma.userRole.create({ data: { userId: attendant2.id, roleId: attendantRole.id } });

  // --- Credit customers ---
  const customers = [
    {
      name: "Mama Mboga",
      phone: "+254700000001",
      customerType: "INDIVIDUAL",
      creditLimit: 5000,
      organizationId: orgId,
    },
    {
      name: "Westlands Bar",
      phone: "+254700000002",
      customerType: "BUSINESS",
      creditLimit: 20000,
      organizationId: orgId,
    },
    {
      name: "Joseph Kimani",
      phone: "+254700000003",
      customerType: "INDIVIDUAL",
      creditLimit: 3000,
      organizationId: orgId,
    },
  ];

  for (const c of customers) {
    await prisma.customer.create({ data: c });
  }

  console.log(`Demo data seeded: ${createdProducts.length} products, 2 attendants, 3 credit customers`);
}

/**
 * Expense categories first, then demo expenses wired to them by real id.
 *
 * The expense table holds a foreign key to ExpenseCategory, so a category name passed
 * where an id belongs fails the whole insert. Seeding the same defaults the categories
 * list creates on first read keeps both paths agreeing on what a new business starts with.
 */
async function seedDemoExpenses(orgId: string) {
  const branch = await prisma.branch.findFirst({ where: { organizationId: orgId } });
  if (!branch) return;

  if ((await prisma.expenseCategory.count({ where: { organizationId: orgId } })) === 0) {
    await prisma.expenseCategory.createMany({
      data: DEFAULT_EXPENSE_CATEGORIES.map(category => ({
        id: generateId(),
        organizationId: orgId,
        name: category.name,
        description: category.description,
        accountCode: category.accountCode,
      })),
    });
  }

  if ((await prisma.expense.count({ where: { organizationId: orgId } })) > 0) return;

  const categories = await prisma.expenseCategory.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true },
  });
  const categoryIdFor = (name: string) =>
    categories.find(category => category.name === name)?.id ?? null;

  const now = new Date();
  await prisma.expense.createMany({
    data: [
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: categoryIdFor("Rent"),
        vendorName: "Landlord Ltd",
        amount: 45000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 5),
        paymentMethod: "BANK_TRANSFER",
      },
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: categoryIdFor("Utilities"),
        vendorName: "Power Co",
        amount: 12000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 10),
        paymentMethod: "BANK_TRANSFER",
      },
      {
        organizationId: orgId,
        branchId: branch.id,
        categoryId: categoryIdFor("Salaries & Wages"),
        vendorName: "Payroll Services",
        amount: 120000,
        currency: "KES",
        expenseDate: new Date(now.getFullYear(), now.getMonth(), 25),
        paymentMethod: "BANK_TRANSFER",
      },
    ],
  });
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
