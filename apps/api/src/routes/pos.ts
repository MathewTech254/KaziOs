import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { isPaystackConfigured, loadConfig } from "@kazios/config";
import { zPosSaleSchema } from "@kazios/validation";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { generateId, generateInvoiceNumber, paginate } from "../lib/utils";
import { getOrganizationId, getScopedValues, isAllowed } from "../lib/scope";

export const posRouter = Router();

const immediatePaymentMethods = new Set(["CASH", "BANK", "MANUAL", "CHECK"]);

function toCents(value: number): number {
  return Math.round(value * 100);
}

function toCurrency(cents: number): number {
  return cents / 100;
}

function roundCents(value: number): number {
  return Math.round(value + Number.EPSILON);
}

function getPaymentMethods() {
  const methods = [
    { id: "CASH", label: "Cash", provider: "CASH", methodType: "cash", configured: true },
    { id: "BANK", label: "Bank transfer", provider: "BANK", methodType: "bank_transfer", configured: true },
    { id: "MANUAL", label: "Manual", provider: "MANUAL", methodType: "manual", configured: true },
    { id: "CHECK", label: "Check", provider: "CHECK", methodType: "check", configured: true },
  ];

  try {
    if (isPaystackConfigured(loadConfig())) {
      methods.push({ id: "PAYSTACK", label: "Paystack", provider: "PAYSTACK", methodType: "card", configured: true });
    }
  } catch {
    return methods;
  }

  return methods;
}

async function getReceipt(invoiceId: string, organizationId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: {
      customer: true,
      branch: true,
      items: { include: { product: true, taxCategory: true } },
      payments: true,
    },
  });

  if (!invoice) throw new AppError(404, "Receipt not found");

  return {
    invoice,
    receiptNumber: invoice.invoiceNumber,
    issuedAt: invoice.createdAt,
    currency: invoice.currency,
  };
}

posRouter.get("/context", requireAuth, requirePermission("pos.sale"), async (req: Request, res: Response) => {
  const organizationId = getOrganizationId(req);
  if (!organizationId) throw new AppError(401, "Authentication required");

  const scopedBranches = getScopedValues(req, "branchId");
  const scopedWarehouses = getScopedValues(req, "warehouseId");
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      branches: scopedBranches.length ? { where: { id: { in: scopedBranches } } } : true,
      warehouses: scopedWarehouses.length ? { where: { id: { in: scopedWarehouses } } } : true,
    },
  });

  if (!organization) throw new AppError(404, "Organization not found");

  const categories = await prisma.category.findMany({
    where: { organizationId },
    include: { _count: { select: { products: true } } },
    orderBy: { name: "asc" },
  });

  res.json({
    data: {
      organization: {
        id: organization.id,
        name: organization.name,
        currency: organization.currency,
        timezone: organization.timezone,
      },
      branches: organization.branches,
      warehouses: organization.warehouses,
      categories,
      paymentMethods: getPaymentMethods(),
    },
  });
});

posRouter.get("/products", requireAuth, requirePermission("pos.sale"), async (req: Request, res: Response) => {
  const organizationId = getOrganizationId(req);
  if (!organizationId) throw new AppError(401, "Authentication required");

  const search = String(req.query.search || "").trim();
  const barcode = String(req.query.barcode || "").trim();
  const categoryId = typeof req.query.categoryId === "string" ? req.query.categoryId : undefined;
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  const warehouseId = typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined;
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 60);
  const pagination = paginate(page, limit);
  const scopedBranches = getScopedValues(req, "branchId");
  const scopedWarehouses = getScopedValues(req, "warehouseId");

  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch || !isAllowed(branchId, scopedBranches)) throw new AppError(403, "This branch is not available for your role");
  }

  if (warehouseId) {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId } });
    if (!warehouse || !isAllowed(warehouseId, scopedWarehouses)) throw new AppError(403, "This warehouse is not available for your role");
    if (branchId && warehouse.branchId !== branchId) throw new AppError(400, "Warehouse does not belong to the selected branch");
  }

  const where: Prisma.ProductWhereInput = {
    organizationId,
    isActive: true,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { sku: { contains: search, mode: "insensitive" } },
            { barcode: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(barcode ? { barcode: { equals: barcode, mode: "insensitive" } } : {}),
    ...(categoryId ? { productCategories: { some: { categoryId } } } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        taxCategory: true,
        brand: true,
        unit: true,
        productCategories: { include: { category: true } },
        inventories: warehouseId ? { where: { warehouseId } } : true,
      },
      orderBy: { name: "asc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.product.count({ where }),
  ]);

  const rows = products.map((product) => {
    const inventory = warehouseId
      ? product.inventories.find((item) => item.warehouseId === warehouseId)
      : product.inventories[0];
    const quantity = inventory ? inventory.quantity - inventory.reserved : 0;
    const minStock = product.minStock;
    return {
      ...product,
      stockQuantity: quantity,
      stockStatus: quantity <= 0 ? "OUT_OF_STOCK" : quantity <= minStock ? "LOW_STOCK" : "IN_STOCK",
      categoryNames: product.productCategories.map((relation) => relation.category.name),
      taxRate: product.taxCategory?.rate || 0,
      taxMode: product.taxCategory?.mode || "EXCLUSIVE",
    };
  });

  res.json({
    data: rows,
    meta: { page: pagination.page, limit: pagination.limit, total },
  });
});

posRouter.post("/sale", requireAuth, requirePermission("pos.sale"), async (req: Request, res: Response) => {
  const organizationId = getOrganizationId(req);
  if (!organizationId) throw new AppError(401, "Authentication required");

  const parsed = zPosSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message || "Invalid sale data");
  }
  const input = parsed.data;
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!organization) throw new AppError(404, "Organization not found");

  if (input.idempotencyKey) {
    const existing = await prisma.invoice.findFirst({
      where: { organizationId, idempotencyKey: input.idempotencyKey },
      include: { customer: true, branch: true, items: { include: { product: true, taxCategory: true } }, payments: true },
    });
    if (existing) {
      res.json({ data: { invoice: existing, receiptNumber: existing.invoiceNumber, changeAmount: 0, idempotent: true } });
      return;
    }
  }

  const scopedBranches = getScopedValues(req, "branchId");
  const scopedWarehouses = getScopedValues(req, "warehouseId");
  const branch = input.branchId
    ? await prisma.branch.findFirst({ where: { id: input.branchId, organizationId } })
    : await prisma.branch.findFirst({ where: { organizationId, isMain: true } }) ||
      await prisma.branch.findFirst({ where: { organizationId } });

  if (!branch || !isAllowed(branch.id, scopedBranches)) throw new AppError(403, "This branch is not available for your role");

  const warehouse = input.warehouseId
    ? await prisma.warehouse.findFirst({ where: { id: input.warehouseId, organizationId } })
    : await prisma.warehouse.findFirst({ where: { organizationId, branchId: branch.id } }) ||
      await prisma.warehouse.findFirst({ where: { organizationId } });

  if (!warehouse || !isAllowed(warehouse.id, scopedWarehouses)) throw new AppError(403, "This warehouse is not available for your role");
  if (warehouse.branchId && warehouse.branchId !== branch.id) throw new AppError(400, "Warehouse does not belong to the selected branch");

  if (input.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: input.customerId, organizationId } });
    if (!customer) throw new AppError(400, "Selected customer is not available in this organization");
  }

  const mergedItems = input.items.reduce<Array<{ productId: string; quantity: number; discountAmount: number }>>((items, item) => {
    const existing = items.find((entry) => entry.productId === item.productId);
    if (existing) existing.quantity += item.quantity;
    else items.push({ productId: item.productId, quantity: item.quantity, discountAmount: item.discountAmount });
    return items;
  }, []);

  const productIds = mergedItems.map((item) => item.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, organizationId, isActive: true },
    include: { taxCategory: true },
  });
  const productMap = new Map(products.map((product) => [product.id, product]));
  const missingProducts = mergedItems.filter((item) => !productMap.has(item.productId));
  if (missingProducts.length) throw new AppError(400, "One or more products are unavailable");

  const orderDiscountCents = Math.max(0, toCents(input.discountAmount));
  const calculatedLines = mergedItems.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) throw new AppError(400, "One or more products are unavailable");
    const grossCents = roundCents(toCents(product.sellingPrice) * item.quantity);
    const lineDiscountCents = Math.min(grossCents, Math.max(0, toCents(item.discountAmount)));
    return { product, quantity: item.quantity, grossCents, lineDiscountCents, baseCents: grossCents - lineDiscountCents };
  });

  const discountBaseCents = calculatedLines.reduce((sum, line) => sum + line.baseCents, 0);
  const appliedOrderDiscountCents = Math.min(orderDiscountCents, discountBaseCents);
  let remainingDiscountCents = appliedOrderDiscountCents;
  calculatedLines.forEach((line, index) => {
    const allocated = index === calculatedLines.length - 1
      ? remainingDiscountCents
      : Math.min(line.baseCents, Math.floor((line.baseCents / discountBaseCents) * appliedOrderDiscountCents));
    line.baseCents -= allocated;
    remainingDiscountCents -= allocated;
  });

  const lines = calculatedLines.map((line) => {
    const rate = line.product.taxCategory?.rate || 0;
    const mode = line.product.taxCategory?.mode || "EXCLUSIVE";
    const taxCents = mode === "INCLUSIVE"
      ? line.baseCents - Math.round(line.baseCents / (1 + rate / 100))
      : Math.round(line.baseCents * rate / 100);
    const netCents = line.baseCents - taxCents;
    return {
      product: line.product,
      quantity: line.quantity,
      unitPriceCents: toCents(line.product.sellingPrice),
      discountCents: line.grossCents - line.baseCents,
      taxCents,
      netCents,
      lineTotalCents: line.baseCents,
      costCents: roundCents(toCents(line.product.costPrice) * line.quantity),
    };
  });

  const subtotalCents = lines.reduce((sum, line) => sum + line.netCents, 0);
  const taxTotalCents = lines.reduce((sum, line) => sum + line.taxCents, 0);
  const discountTotalCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
  const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const costTotalCents = lines.reduce((sum, line) => sum + line.costCents, 0);

  const paymentCents = input.payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
  if (paymentCents !== totalCents) throw new AppError(400, "Payment amount must match the sale total");

  const tenderedCents = input.payments.reduce((sum, payment) => sum + toCents(payment.tenderedAmount ?? payment.amount), 0);
  if (tenderedCents < totalCents) throw new AppError(400, "Tendered amount is less than the sale total");

  for (const payment of input.payments) {
    if (!immediatePaymentMethods.has(payment.provider)) {
      throw new AppError(400, `${payment.provider} payments require server-side verification and are not available at this terminal`);
    }
    if (payment.provider === "CASH" && payment.methodType !== "cash") throw new AppError(400, "Cash payment method is invalid");
  }

  const invoiceNumber = generateInvoiceNumber("POS");
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    for (const line of lines) {
      if (!line.product.trackStock || line.product.productType === "SERVICE" || line.product.productType === "DIGITAL") continue;
      const inventory = await tx.inventory.findUnique({ where: { productId_warehouseId: { productId: line.product.id, warehouseId: warehouse.id } } });
      const available = inventory ? inventory.quantity - inventory.reserved : 0;
      if (!inventory || available < line.quantity) {
        throw new AppError(409, `${line.product.name} has only ${available} available in this warehouse`);
      }
      const updated = await tx.inventory.updateMany({
        where: { productId: line.product.id, warehouseId: warehouse.id, quantity: { gte: line.quantity + inventory.reserved } },
        data: { quantity: { decrement: line.quantity } },
      });
      if (updated.count !== 1) throw new AppError(409, `${line.product.name} stock changed; please review the cart`);
    }

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        status: "PAID",
        issueDate: now,
        dueDate: now,
        subtotal: toCurrency(subtotalCents),
        taxTotal: toCurrency(taxTotalCents),
        discountTotal: toCurrency(discountTotalCents),
        total: toCurrency(totalCents),
        currency: organization.currency,
        paidAmount: toCurrency(totalCents),
        notes: input.notes || "POS sale",
        organizationId,
        customerId: input.customerId || null,
        branchId: branch.id,
        idempotencyKey: input.idempotencyKey || null,
      },
    });

    await tx.invoiceItem.createMany({
      data: lines.map((line) => ({
        invoiceId: invoice.id,
        productId: line.product.id,
        description: line.product.name,
        quantity: line.quantity,
        unitPrice: toCurrency(line.unitPriceCents),
        discountAmount: toCurrency(line.discountCents),
        taxRateId: line.product.taxCategoryId,
        taxAmount: toCurrency(line.taxCents),
        lineTotal: toCurrency(line.lineTotalCents),
      })),
    });

    const referencePrefix = `POS-${Date.now()}-${generateId().slice(0, 8)}`;
    await tx.payment.createMany({
      data: input.payments.map((payment, index) => ({
        reference: `${referencePrefix}-${index + 1}`,
        amount: toCurrency(toCents(payment.amount)),
        currency: organization.currency,
        provider: payment.provider,
        methodType: payment.methodType,
        status: "SUCCESS",
        providerRef: payment.reference || null,
        notes: "Server-verified POS payment",
        paidAt: now,
        organizationId,
        invoiceId: invoice.id,
        customerId: input.customerId || null,
        branchId: branch.id,
      })),
    });

    const movementLines = lines.filter((line) => line.product.trackStock && line.product.productType !== "SERVICE" && line.product.productType !== "DIGITAL");
    if (movementLines.length) {
      await tx.stockMovement.createMany({
        data: movementLines.map((line) => ({
          type: "SALE",
          quantity: -line.quantity,
          reason: "POS sale",
          reference: invoice.invoiceNumber,
          organizationId,
          productId: line.product.id,
          warehouseId: warehouse.id,
          branchId: branch.id,
        })),
      });
    }

    const accountByCode = new Map<string, string>();
    const getAccount = async (code: string, name: string, type: string) => {
      const existing = accountByCode.get(code);
      if (existing) return existing;
      const account = await tx.account.upsert({
        where: { organizationId_code: { organizationId, code } },
        update: {},
        create: { organizationId, code, name, type, isSystem: true },
      });
      accountByCode.set(code, account.id);
      return account.id;
    };

    const cashAccountId = input.payments.every((payment) => payment.provider === "BANK")
      ? await getAccount("1100", "Bank", "ASSET")
      : await getAccount("1000", "Cash", "ASSET");
    const revenueAccountId = await getAccount("4000", "Sales Revenue", "REVENUE");
    const journalLines: Array<{ accountId: string; description: string; debit: number; credit: number }> = [
      { accountId: cashAccountId, description: `POS sale ${invoice.invoiceNumber}`, debit: toCurrency(totalCents), credit: 0 },
      { accountId: revenueAccountId, description: `POS revenue ${invoice.invoiceNumber}`, debit: 0, credit: toCurrency(subtotalCents) },
    ];
    if (taxTotalCents) {
      const taxAccountId = await getAccount("2100", "Tax Payable", "LIABILITY");
      journalLines.push({ accountId: taxAccountId, description: `POS tax ${invoice.invoiceNumber}`, debit: 0, credit: toCurrency(taxTotalCents) });
    }
    if (costTotalCents) {
      const cogsAccountId = await getAccount("5000", "Cost of Goods Sold", "EXPENSE");
      const inventoryAccountId = await getAccount("1200", "Inventory Asset", "ASSET");
      journalLines.push({ accountId: cogsAccountId, description: `POS cost of goods ${invoice.invoiceNumber}`, debit: toCurrency(costTotalCents), credit: 0 });
      journalLines.push({ accountId: inventoryAccountId, description: `POS inventory relief ${invoice.invoiceNumber}`, debit: 0, credit: toCurrency(costTotalCents) });
    }

    await tx.journalEntry.create({
      data: {
        reference: `JE-${generateId()}`,
        description: `POS sale ${invoice.invoiceNumber}`,
        journalDate: now,
        status: "POSTED",
        organizationId,
        lines: { create: journalLines },
      },
    });

    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { customer: true, branch: true, items: { include: { product: true, taxCategory: true } }, payments: true },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (!result) throw new AppError(500, "Sale could not be completed");

  res.status(201).json({
    data: {
      invoice: result,
      receiptNumber: invoiceNumber,
      changeAmount: toCurrency(tenderedCents - totalCents),
      currency: organization.currency,
    },
  });
});

posRouter.get("/receipt/:invoiceId", requireAuth, requirePermission("pos.sale"), async (req: Request, res: Response) => {
  const organizationId = getOrganizationId(req);
  if (!organizationId) throw new AppError(401, "Authentication required");
  res.json({ data: await getReceipt(req.params.invoiceId, organizationId) });
});
