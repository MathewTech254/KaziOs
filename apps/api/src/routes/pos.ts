import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { isPaystackConfigured, loadConfig } from "@kazios/config";
import { zPosSaleSchema } from "@kazios/validation";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission } from "../middleware/auth";
import type { AuthRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { generateId, generateInvoiceNumber, paginate } from "../lib/utils";
import { getOrganizationId, getScopedValues, getUserId, isAllowed } from "../lib/scope";
import { notifyPermissionHolders } from "../services/notifications";
import { alertOnLowStock } from "../services/stockAlerts";
import { reverseSale } from "../services/saleReturns";
import { enqueueEtimsSubmission } from "../services/etims/outbox";
import { LIMIT_KEYS } from "@kazios/types";
import { assertWithinLimit, getEntitlements } from "../services/entitlements";
import { recordTransaction } from "../services/usage";
import { isMpesaEnabled } from "../lib/mpesa";
import { confirmMpesaPosPayment, startMpesaPosPayment } from "../services/mpesaPos";

export const posRouter = Router();

const immediatePaymentMethods = new Set([
  "CASH",
  "BANK",
  "MANUAL",
  "CHECK",
  "MPESA_MANUAL",
  "CREDIT",
]);

/**
 * Two rails record the sale before their money is: a card sale waits for Paystack and an
 * M-PESA sale for Safaricom, so the invoice is written up front unpaid (bar any tender
 * already in hand) and it turns paid only when the provider confirms. Stock still leaves
 * the shelf because the goods do leave the counter the moment the sale is rung up.
 *
 * MPESA_MANUAL is a manual code entry: the cashier keys in the M-PESA transaction code
 * the customer shows them. It is treated as immediate (money is considered in hand once
 * the code is accepted and deduplicated), but the code itself is the proof of payment.
 */
const deferredPaymentMethods = new Set(["PAYSTACK", "MPESA"]);

/** Each deferred rail insists on its own methodType; anything else is a client bug. */
const deferredMethodType: Record<string, string> = {
  PAYSTACK: "card",
  MPESA: "mobile_money",
};

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
    {
      id: "BANK",
      label: "Bank transfer",
      provider: "BANK",
      methodType: "bank_transfer",
      configured: true,
    },
    { id: "MANUAL", label: "Manual", provider: "MANUAL", methodType: "manual", configured: true },
    { id: "CHECK", label: "Check", provider: "CHECK", methodType: "check", configured: true },
  ];

  try {
    const config = loadConfig();
    if (isPaystackConfigured(config) && config.paystack.publicKey) {
      // The public key is designed to be seen by the browser. The secret key never is.
      methods.push({
        id: "PAYSTACK",
        label: "Card (Paystack)",
        provider: "PAYSTACK",
        methodType: "card",
        configured: true,
      });
    }
  } catch {
    // The card config could not be read, so card stays hidden. M-PESA still decides
    // for itself below: it reads its own credentials and never throws.
  }

  // Offered only when the Daraja credentials are actually set — the same posture as
  // card behind Paystack's keys, and as billing's mpesaEnabled flag (routes/billing.ts).
  if (isMpesaEnabled()) {
    methods.push({
      id: "MPESA",
      label: "M-PESA",
      provider: "MPESA",
      methodType: "mobile_money",
      configured: true,
    });
  }

  return methods;
}

async function getReceipt(invoiceId: string, organizationId: string, userId?: string) {
  const where: any = { id: invoiceId, organizationId };
  if (userId) where.recordedById = userId;
  const invoice = await prisma.invoice.findFirst({
    where,
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

posRouter.get(
  "/context",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
          // The public key is safe to hand to the browser; the secret key never leaves the server.
          cardPublicKey: (() => {
            try {
              const config = loadConfig();
              return isPaystackConfigured(config) ? config.paystack.publicKey || null : null;
            } catch {
              return null;
            }
          })(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

posRouter.get(
  "/products",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const search = String(req.query.search || "").trim();
      const barcode = String(req.query.barcode || "").trim();
      const categoryId =
        typeof req.query.categoryId === "string" ? req.query.categoryId : undefined;
      const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
      const warehouseId =
        typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined;
      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 60);
      const pagination = paginate(page, limit);
      const scopedBranches = getScopedValues(req, "branchId");
      const scopedWarehouses = getScopedValues(req, "warehouseId");

      if (branchId) {
        const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId } });
        if (!branch || !isAllowed(branchId, scopedBranches))
          throw new AppError(403, "This branch is not available for your role");
      }

      if (warehouseId) {
        const warehouse = await prisma.warehouse.findFirst({
          where: { id: warehouseId, organizationId },
        });
        if (!warehouse || !isAllowed(warehouseId, scopedWarehouses))
          throw new AppError(403, "This warehouse is not available for your role");
        // branchId null marks an org-wide warehouse, which serves every branch — the same
        // rule /sale already enforces (`warehouse.branchId && ...`). Without the null guard
        // the pairing the POS itself builds (Main Branch + the org-wide Main Warehouse)
        // threw here, and because this handler had no try/catch the rejection was swallowed
        // by the process-level handler: no response was ever sent and the till sat on
        // "Loading products..." forever.
        if (branchId && warehouse.branchId && warehouse.branchId !== branchId)
          throw new AppError(400, "Warehouse does not belong to the selected branch");
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

      const rows = products.map(product => {
        const inventory = warehouseId
          ? product.inventories.find(item => item.warehouseId === warehouseId)
          : product.inventories[0];
        const quantity = inventory ? inventory.quantity - inventory.reserved : 0;
        const minStock = product.minStock;
        const base = {
          ...product,
          stockQuantity: quantity,
          stockStatus:
            quantity <= 0 ? "OUT_OF_STOCK" : quantity <= minStock ? "LOW_STOCK" : "IN_STOCK",
          categoryNames: product.productCategories.map(relation => relation.category.name),
          taxRate: product.taxCategory?.rate || 0,
          taxMode: product.taxCategory?.mode || "EXCLUSIVE",
        };
        // Attendants must not see cost prices.
        const isOwner = req.roles?.some((r: any) => r.role.permissions.includes("*")) ?? false;
        if (isOwner) return base;
        const { costPrice: _cp, ...rest } = base;
        return rest;
      });

      res.json({
        data: rows,
        meta: { page: pagination.page, limit: pagination.limit, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// The whole handler is wrapped in try/catch and ends in next(err).
//
// This matters more than it looks. An async Express handler that throws without a
// next turns into an unhandled promise rejection, which Node takes as a fatal error:
// the process dies and takes the API with it. Every rejection here used to end the
// whole server rather than return an error to the till.
posRouter.post(
  "/sale",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const parsed = zPosSaleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || "Invalid sale data");
      }
      const input = parsed.data;
      const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
      if (!organization) throw new AppError(404, "Organization not found");

      // A closed trading day blocks new sales for attendants. The owner can reopen
      // via /day-closings/reopen. Compute "today" in the organization's own timezone.
      const tz = organization.timezone || "UTC";
      const todayParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour12: false,
      }).formatToParts(new Date());
      const get = (type: string) => Number(todayParts.find(p => p.type === type)?.value);
      const today = `${get("year")}-${String(get("month")).padStart(2, "0")}-${String(
        get("day")
      ).padStart(2, "0")}`;

      const dayClosing = await prisma.dayClosing.findUnique({
        where: { organizationId_date: { organizationId, date: today } },
      });
      const isOwnerOrClosingManager =
        req.roles?.some(
          (r: any) =>
            r.role.permissions.includes("*") || r.role.permissions.includes("closing.manage")
        ) ?? false;
      if (dayClosing && dayClosing.status === "CLOSED" && !isOwnerOrClosingManager) {
        throw new AppError(
          409,
          `Today (${today}) is closed. Reopen the day before making another sale.`
        );
      }

      // POS settings: allowNegativeStock defaults to false. Read from the stored
      // setting, falling back to the schema default when none is stored for this org.
      const settingsRow = await prisma.setting.findUnique({
        where: { organizationId_key: { organizationId, key: "pos" } },
      });
      const posSettings: { allowNegativeStock?: boolean } = settingsRow
        ? ((settingsRow.value as Record<string, unknown> | null) ?? {})
        : {};
      const allowNegativeStock = posSettings.allowNegativeStock ?? false;

      // --- Payment method validation before the transaction -----------------------
      const mpesaManualCodes = new Set<string>();
      let hasCredit = false;
      let creditCustomerId: string | null = null;

      for (const payment of input.payments) {
        if (deferredPaymentMethods.has(payment.provider)) {
          if (payment.methodType !== deferredMethodType[payment.provider])
            throw new AppError(400, `${payment.provider} payment method is invalid`);
          continue;
        }
        if (!immediatePaymentMethods.has(payment.provider)) {
          throw new AppError(
            400,
            `${payment.provider} payments require server-side verification and are not available at this terminal`
          );
        }
        if (payment.provider === "CASH" && payment.methodType !== "cash")
          throw new AppError(400, "Cash payment method is invalid");

        if (payment.provider === "MPESA_MANUAL") {
          if (payment.methodType !== "manual")
            throw new AppError(400, "MPESA_MANUAL payment method is invalid");
          if (!payment.transactionCode || payment.transactionCode.trim() === "")
            throw new AppError(400, "MPESA_MANUAL requires a transaction code");
          // Normalize: trim + uppercase so "abc123" and "ABC 123" are the same code.
          const code = payment.transactionCode.trim().toUpperCase();
          if (mpesaManualCodes.has(code))
            throw new AppError(400, "Duplicate M-PESA transaction code in this sale");
          mpesaManualCodes.add(code);
          // Store the normalized code back so it's persisted consistently.
          payment.transactionCode = code;
        }

        if (payment.provider === "CREDIT") {
          if (payment.methodType !== "credit")
            throw new AppError(400, "CREDIT payment method is invalid");
          if (!input.customerId) throw new AppError(400, "CREDIT sales require a customer");
          hasCredit = true;
          creditCustomerId = input.customerId;
        }
      }

      // Duplicate M-PESA codes across the organization (not just this sale).
      for (const code of mpesaManualCodes) {
        const existing = await prisma.payment.findFirst({
          where: {
            organizationId,
            provider: "MPESA_MANUAL",
            providerRef: code,
          },
        });
        if (existing) throw new AppError(409, `M-PESA transaction code "${code}" was already used`);
      }

      // Credit limit enforcement for CREDIT sales.
      if (hasCredit && creditCustomerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: creditCustomerId, organizationId },
        });
        if (!customer)
          throw new AppError(400, "Selected customer is not available in this organization");

        const creditLimit = customer.creditLimit ?? null;
        if (creditLimit !== null) {
          // Balance owed = unpaid invoice totals minus standalone customer repayments.
          const [invoices, repayments] = await Promise.all([
            prisma.invoice.aggregate({
              where: {
                customerId: creditCustomerId,
                organizationId,
                status: { not: "VOID" },
              },
              _sum: { total: true, paidAmount: true },
            }),
            prisma.payment.aggregate({
              where: {
                customerId: creditCustomerId,
                organizationId,
                provider: "CREDIT",
                invoiceId: null,
                status: "SUCCESS",
              },
              _sum: { amount: true },
            }),
          ]);

          const owed = Number(invoices._sum.total ?? 0) - Number(invoices._sum.paidAmount ?? 0);
          const repaid = Number(repayments._sum.amount ?? 0);
          const currentBalance = owed - repaid;

          const orderTotalCents = input.payments.reduce((sum, p) => sum + toCents(p.amount), 0);
          const orderTotal = toCurrency(orderTotalCents);

          if (currentBalance + orderTotal > creditLimit) {
            // Owner-level override: a user with settings.manage can explicitly
            // override the credit limit. Requires an opt-in confirmation flag and
            // is always audit-logged.
            const canOverride = req.roles?.some(
              (r: any) =>
                r.role.permissions.includes("*") || r.role.permissions.includes("settings.manage")
            );
            if (
              canOverride &&
              input.overrideCreditLimit === true &&
              input.overrideCreditLimitReason
            ) {
              await prisma.auditLog.create({
                data: {
                  organizationId,
                  userId: req.userId,
                  entity: "Customer",
                  entityId: creditCustomerId,
                  action: "CREDIT_LIMIT_OVERRIDE",
                  changes: {
                    customerName: customer.name,
                    currentBalance,
                    orderTotal,
                    creditLimit,
                    reason: input.overrideCreditLimitReason,
                  },
                },
              });
            } else {
              throw new AppError(
                409,
                `Customer credit limit exceeded: owes KES ${currentBalance.toFixed(2)}, ` +
                  `this sale adds KES ${orderTotal.toFixed(2)}, limit is KES ${creditLimit.toFixed(2)}`
              );
            }
          }
        }
      }

      // Counted against the plan before anything is written, so a business that has reached
      // its monthly allowance is told why and offered the upgrade rather than having a
      // till fail mid market with a generic error.
      //
      // Best effort in the sense of the check itself, not of the outcome: if this cannot be
      // answered we still take the sale. Refusing a customer's purchase because a plan row
      // was slow to load would cost a real business real money.
      await assertWithinLimit(
        await getEntitlements(organizationId),
        LIMIT_KEYS.MONTHLY_TRANSACTIONS,
        { adding: 1 }
      ).catch(err => {
        if (err instanceof AppError && err.code === "LIMIT_REACHED") throw err;
        console.warn("Could not check the transaction allowance before a sale:", err);
      });

      if (input.idempotencyKey) {
        const existing = await prisma.invoice.findFirst({
          where: { organizationId, idempotencyKey: input.idempotencyKey },
          include: {
            customer: true,
            branch: true,
            items: { include: { product: true, taxCategory: true } },
            payments: true,
          },
        });
        if (existing) {
          res.json({
            data: {
              invoice: existing,
              receiptNumber: existing.invoiceNumber,
              changeAmount: 0,
              idempotent: true,
            },
          });
          return;
        }
      }

      const scopedBranches = getScopedValues(req, "branchId");
      const scopedWarehouses = getScopedValues(req, "warehouseId");
      const branch = input.branchId
        ? await prisma.branch.findFirst({ where: { id: input.branchId, organizationId } })
        : (await prisma.branch.findFirst({ where: { organizationId, isMain: true } })) ||
          (await prisma.branch.findFirst({ where: { organizationId } }));

      if (!branch || !isAllowed(branch.id, scopedBranches))
        throw new AppError(403, "This branch is not available for your role");

      const warehouse = input.warehouseId
        ? await prisma.warehouse.findFirst({ where: { id: input.warehouseId, organizationId } })
        : (await prisma.warehouse.findFirst({ where: { organizationId, branchId: branch.id } })) ||
          (await prisma.warehouse.findFirst({ where: { organizationId } }));

      if (!warehouse || !isAllowed(warehouse.id, scopedWarehouses))
        throw new AppError(403, "This warehouse is not available for your role");
      if (warehouse.branchId && warehouse.branchId !== branch.id)
        throw new AppError(400, "Warehouse does not belong to the selected branch");

      if (input.customerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: input.customerId, organizationId },
        });
        if (!customer)
          throw new AppError(400, "Selected customer is not available in this organization");
      }

      const mergedItems = input.items.reduce<
        { productId: string; quantity: number; discountAmount: number }[]
      >((items, item) => {
        const existing = items.find(entry => entry.productId === item.productId);
        if (existing) existing.quantity += item.quantity;
        else
          items.push({
            productId: item.productId,
            quantity: item.quantity,
            discountAmount: item.discountAmount,
          });
        return items;
      }, []);

      const productIds = mergedItems.map(item => item.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, organizationId, isActive: true },
        include: { taxCategory: true },
      });
      const productMap = new Map(products.map(product => [product.id, product]));
      const missingProducts = mergedItems.filter(item => !productMap.has(item.productId));
      if (missingProducts.length) throw new AppError(400, "One or more products are unavailable");

      const orderDiscountCents = Math.max(0, toCents(input.discountAmount));
      const calculatedLines = mergedItems.map(item => {
        const product = productMap.get(item.productId);
        if (!product) throw new AppError(400, "One or more products are unavailable");
        const grossCents = roundCents(toCents(product.sellingPrice) * item.quantity);
        const lineDiscountCents = Math.min(grossCents, Math.max(0, toCents(item.discountAmount)));
        return {
          product,
          quantity: item.quantity,
          grossCents,
          lineDiscountCents,
          baseCents: grossCents - lineDiscountCents,
        };
      });

      const discountBaseCents = calculatedLines.reduce((sum, line) => sum + line.baseCents, 0);
      const appliedOrderDiscountCents = Math.min(orderDiscountCents, discountBaseCents);
      let remainingDiscountCents = appliedOrderDiscountCents;
      calculatedLines.forEach((line, index) => {
        const allocated =
          index === calculatedLines.length - 1
            ? remainingDiscountCents
            : Math.min(
                line.baseCents,
                Math.floor((line.baseCents / discountBaseCents) * appliedOrderDiscountCents)
              );
        line.baseCents -= allocated;
        remainingDiscountCents -= allocated;
      });

      const lines = calculatedLines.map(line => {
        const rate = line.product.taxCategory?.rate || 0;
        const mode = line.product.taxCategory?.mode || "EXCLUSIVE";

        // EXCLUSIVE means the shelf price excludes VAT, so the tax is added on top and
        // the net is the line as priced. INCLUSIVE means the price already contains the
        // VAT, so the tax has to be extracted from it and the net is smaller than the
        // price.
        //
        // These two were previously conflated: netCents was computed as base - taxCents
        // for both, which quietly took the VAT out of an EXCLUSIVE line a second time.
        // The customer was charged 378.00 for goods priced at 378.00 and told the
        // subtotal was 317.52, and every reconciliation against the till was wrong.
        const taxCents =
          mode === "INCLUSIVE"
            ? line.baseCents - Math.round(line.baseCents / (1 + rate / 100))
            : Math.round((line.baseCents * rate) / 100);
        const netCents = mode === "INCLUSIVE" ? line.baseCents - taxCents : line.baseCents;
        return {
          product: line.product,
          quantity: line.quantity,
          unitPriceCents: toCents(line.product.sellingPrice),
          discountCents: line.grossCents - line.baseCents,
          taxCents,
          netCents,
          // What the customer actually pays for this line: net plus the tax on top of it.
          lineTotalCents: netCents + taxCents,
          costCents: roundCents(toCents(line.product.costPrice) * line.quantity),
        };
      });

      const subtotalCents = lines.reduce((sum, line) => sum + line.netCents, 0);
      const taxTotalCents = lines.reduce((sum, line) => sum + line.taxCents, 0);
      const discountTotalCents = lines.reduce((sum, line) => sum + line.discountCents, 0);
      const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
      const costTotalCents = lines.reduce((sum, line) => sum + line.costCents, 0);

      const paymentCents = input.payments.reduce(
        (sum, payment) => sum + toCents(payment.amount),
        0
      );
      if (paymentCents !== totalCents)
        throw new AppError(400, "Payment amount must match the sale total");

      const tenderedCents = input.payments.reduce(
        (sum, payment) => sum + toCents(payment.tenderedAmount ?? payment.amount),
        0
      );
      if (tenderedCents < totalCents)
        throw new AppError(400, "Tendered amount is less than the sale total");

      const hasDeferredPayment = input.payments.some(payment =>
        deferredPaymentMethods.has(payment.provider)
      );
      // Money actually in hand — every tender whose provider does not still have to
      // confirm. CREDIT is excluded: the money is owed by the customer, not received.
      // Computed before the transaction because it seeds the invoice's paidAmount.
      const settledPayments = input.payments.filter(
        payment => !deferredPaymentMethods.has(payment.provider) && payment.provider !== "CREDIT"
      );
      const settledCents = settledPayments.reduce(
        (sum, payment) => sum + toCents(payment.amount),
        0
      );
      for (const payment of input.payments) {
        if (deferredPaymentMethods.has(payment.provider)) {
          if (payment.methodType !== deferredMethodType[payment.provider])
            throw new AppError(400, `${payment.provider} payment method is invalid`);
          continue;
        }
        if (!immediatePaymentMethods.has(payment.provider)) {
          throw new AppError(
            400,
            `${payment.provider} payments require server-side verification and are not available at this terminal`
          );
        }
        if (payment.provider === "CASH" && payment.methodType !== "cash")
          throw new AppError(400, "Cash payment method is invalid");
      }

      const invoiceNumber = generateInvoiceNumber("POS");
      const now = new Date();

      // Serializable transactions can abort under concurrent access (Prisma P2034).
      // Retry once so the till doesn't fail a customer's purchase because two
      // sales hit the same stock at the same instant.
      let result: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await prisma.$transaction(
            async tx => {
              for (const line of lines) {
                if (
                  !line.product.trackStock ||
                  line.product.productType === "SERVICE" ||
                  line.product.productType === "DIGITAL"
                )
                  continue;
                const inventory = await tx.inventory.findUnique({
                  where: {
                    productId_warehouseId: {
                      productId: line.product.id,
                      warehouseId: warehouse.id,
                    },
                  },
                });
                const available = inventory ? inventory.quantity - inventory.reserved : 0;
                if (!inventory || (available < line.quantity && !allowNegativeStock)) {
                  throw new AppError(
                    409,
                    `${line.product.name} has only ${available} available in this warehouse`
                  );
                }
                const updated = await tx.inventory.updateMany({
                  where: {
                    productId: line.product.id,
                    warehouseId: warehouse.id,
                    ...(allowNegativeStock
                      ? {}
                      : { quantity: { gte: line.quantity + inventory.reserved } }),
                  },
                  data: { quantity: { decrement: line.quantity } },
                });
                if (!allowNegativeStock && updated.count !== 1)
                  throw new AppError(
                    409,
                    `${line.product.name} stock changed; please review the cart`
                  );
              }

              const invoice = await tx.invoice.create({
                data: {
                  invoiceNumber,
                  status:
                    settledCents >= totalCents
                      ? "PAID"
                      : settledCents > 0
                        ? "PARTIALLY_PAID"
                        : "SENT",
                  issueDate: now,
                  dueDate: now,
                  subtotal: toCurrency(subtotalCents),
                  taxTotal: toCurrency(taxTotalCents),
                  discountTotal: toCurrency(discountTotalCents),
                  total: toCurrency(totalCents),
                  currency: organization.currency,
                  paidAmount: toCurrency(settledCents),
                  notes: input.notes || "POS sale",
                  organizationId,
                  customerId: input.customerId || null,
                  branchId: branch.id,
                  recordedById: req.userId,
                  idempotencyKey: input.idempotencyKey || null,
                },
              });

              await tx.invoiceItem.createMany({
                data: lines.map(line => ({
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
              // Only money that is actually in hand is written here (settledPayments was
              // decided above, before the invoice took its opening paidAmount). A deferred
              // payment is left out entirely; it is recorded by the verified confirm path
              // once Paystack or Safaricom says the money moved.
              if (settledPayments.length) {
                await tx.payment.createMany({
                  data: settledPayments.map((payment, index) => ({
                    reference: `${referencePrefix}-${index + 1}`,
                    amount: toCurrency(toCents(payment.amount)),
                    currency: organization.currency,
                    provider: payment.provider,
                    methodType: payment.methodType,
                    status: "SUCCESS",
                    providerRef:
                      payment.provider === "MPESA_MANUAL"
                        ? payment.transactionCode?.trim() || null
                        : payment.reference || null,
                    notes: "Server-verified POS payment",
                    paidAt: now,
                    organizationId,
                    invoiceId: invoice.id,
                    customerId: input.customerId || null,
                    branchId: branch.id,
                  })),
                });
              }

              const movementLines = lines.filter(
                line =>
                  line.product.trackStock &&
                  line.product.productType !== "SERVICE" &&
                  line.product.productType !== "DIGITAL"
              );
              if (movementLines.length) {
                await tx.stockMovement.createMany({
                  data: movementLines.map(line => ({
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

              const cashAccountId = input.payments.every(payment => payment.provider === "BANK")
                ? await getAccount("1100", "Bank", "ASSET")
                : await getAccount("1000", "Cash", "ASSET");
              const revenueAccountId = await getAccount("4000", "Sales Revenue", "REVENUE");
              const journalLines: {
                accountId: string;
                description: string;
                debit: number;
                credit: number;
              }[] = [
                {
                  accountId: cashAccountId,
                  description: `POS sale ${invoice.invoiceNumber}`,
                  debit: toCurrency(totalCents),
                  credit: 0,
                },
                {
                  accountId: revenueAccountId,
                  description: `POS revenue ${invoice.invoiceNumber}`,
                  debit: 0,
                  credit: toCurrency(subtotalCents),
                },
              ];
              if (taxTotalCents) {
                const taxAccountId = await getAccount("2100", "Tax Payable", "LIABILITY");
                journalLines.push({
                  accountId: taxAccountId,
                  description: `POS tax ${invoice.invoiceNumber}`,
                  debit: 0,
                  credit: toCurrency(taxTotalCents),
                });
              }
              if (costTotalCents) {
                const cogsAccountId = await getAccount("5000", "Cost of Goods Sold", "EXPENSE");
                const inventoryAccountId = await getAccount("1200", "Inventory Asset", "ASSET");
                journalLines.push({
                  accountId: cogsAccountId,
                  description: `POS cost of goods ${invoice.invoiceNumber}`,
                  debit: toCurrency(costTotalCents),
                  credit: 0,
                });
                journalLines.push({
                  accountId: inventoryAccountId,
                  description: `POS inventory relief ${invoice.invoiceNumber}`,
                  debit: 0,
                  credit: toCurrency(costTotalCents),
                });
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
                include: {
                  customer: true,
                  branch: true,
                  items: { include: { product: true, taxCategory: true } },
                  payments: true,
                },
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          );
          break; // success, exit retry loop
        } catch (err: any) {
          // Prisma P2034 = Serializable transaction aborted due to concurrent write.
          // Retry once so the till doesn't fail a customer's purchase under contention.
          if (err.code === "P2034" && attempt === 0) continue;
          // Any other error (insufficient stock, credit limit, etc.) is re-thrown as-is.
          throw err;
        }
      }

      if (!result) throw new AppError(500, "Sale could not be completed");

      // The till that rang the sale already knows about it, so the alert goes to everyone
      // else who can see reporting. An owner watching the dashboard sees the shop taking
      // money without refreshing, which is the point of having this at all.
      await notifyPermissionHolders({
        organizationId,
        permission: "reports.view",
        title: "Sale completed",
        body: `${result.invoiceNumber} for ${organization.currency} ${toCurrency(totalCents).toFixed(2)}`,
        type: "success",
        link: "/dashboard/invoices",
        actorName: String(req.body?.soldBy || "").trim() || undefined,
        excludeUserIds: [getUserId(req)!],
      }).catch(() => 0);

      // A sale is the moment stock actually leaves the shelf, so it is the most reliable
      // point to notice a product has just fallen to its reorder level.
      await alertOnLowStock(
        organizationId,
        lines.map(line => line.product.id),
        warehouse.id
      ).catch(() => 0);

      // Counted after the sale is committed, never before. The sale is the thing that
      // happened; if this write fails the customer still paid and still has their goods.
      // Best effort for the same reason, and it means a busy month is under-counted by
      // whatever a counter write lost, which is the correct direction to be wrong in.
      await recordTransaction(organizationId).catch(() => 0);

      // Filed with KRA whether or not KRA is reachable: the outbox row is written now and
      // the submission retried by the worker. Best effort on purpose — the customer has
      // already paid and is already holding their goods, so a filing problem must never
      // be able to fail a completed sale.
      await enqueueEtimsSubmission(result.id, organizationId).catch(err => {
        console.warn(`Could not queue ${result.invoiceNumber} for KRA eTIMS:`, err);
      });

      res.status(201).json({
        data: {
          invoice: result,
          receiptNumber: invoiceNumber,
          // A deferred sale has no full amount in hand yet, so there is no change to give back.
          changeAmount: hasDeferredPayment ? 0 : toCurrency(tenderedCents - totalCents),
          currency: organization.currency,
          // The client needs the invoice id to open the deferred payment — card popup or
          // M-PESA prompt — for this exact sale. requiresCardPayment stays card's own flag
          // so nothing that checks it is ever told an M-PESA sale was a card sale.
          ...(hasDeferredPayment
            ? {
                invoiceId: result.id,
                ...(input.payments.some(payment => payment.provider === "PAYSTACK")
                  ? { requiresCardPayment: true }
                  : {}),
              }
            : {}),
        },
      });
    } catch (err) {
      // Reported like any other route failure: the sale is rolled back by its own
      // transaction, and the till gets a message it can act on rather than a dead server.
      next(err);
    }
  }
);

/**
 * Return a POS sale: restores stock for every tracked line item back to the
 * warehouse it was taken from, then marks the invoice void.
 *
 * Manager-level. A cashier correcting their own mistake uses /sales/:id/cancel
 * below, which is the same reversal with a tighter authorisation rule.
 *
 * The warehouse may be omitted, in which case the goods go back to the branch the sale
 * was rung at — the shelf they came from. A shop with one store never has to choose.
 */
posRouter.post(
  "/sales/:id/return",
  requireAuth,
  requirePermission("invoices.void"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId },
        select: { id: true, invoiceNumber: true, status: true, branchId: true },
      });
      if (!invoice) throw new AppError(404, "Sale not found");

      // reverseSale owns the status rules so the till, this route and the invoice
      // screen cannot disagree about what is returnable.
      let warehouseId = typeof req.body?.warehouseId === "string" ? req.body.warehouseId : "";
      if (!warehouseId) {
        const fallback = await prisma.warehouse.findFirst({
          where: {
            organizationId,
            ...(invoice.branchId ? { branchId: invoice.branchId } : {}),
          },
          orderBy: { createdAt: "asc" },
        });
        warehouseId = fallback?.id ?? "";
      }

      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim()
          : "POS return";

      const result = await reverseSale({
        invoiceId: invoice.id,
        organizationId,
        warehouseId,
        reason,
      });

      const restoredCount = result.restored.reduce((sum, line) => sum + line.quantity, 0);

      await notifyPermissionHolders({
        organizationId,
        permission: "reports.view",
        title: "Sale returned",
        body:
          `${invoice.invoiceNumber} returned to ${result.warehouse.name}` +
          (restoredCount ? ` — ${restoredCount} unit(s) back on the shelf` : ""),
        type: "warning",
        link: "/dashboard/invoices",
        actorName: String(req.body?.soldBy || "").trim() || undefined,
        excludeUserIds: [getUserId(req)!],
      }).catch(() => 0);

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Cancel an unpaid sale from the till that rang it.
 *
 * A card or M-PESA sale is written before its money is, so a declined card or an
 * abandoned STK prompt leaves a real invoice holding real stock. Before this the only
 * way back was a manager with invoices.void, which is not who is standing at the till
 * when the customer walks off.
 *
 * The rule is deliberately narrow: the cashier who recorded the sale may cancel it,
 * but only while no money has been taken. Anything settled has to go through a refund,
 * because silently reversing a sale that took cash would make the drawer unreadable.
 * Anyone holding invoices.void may cancel any sale, paid or not.
 */
posRouter.post(
  "/sales/:id/cancel",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.id, organizationId },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          total: true,
          paidAmount: true,
          recordedById: true,
          branchId: true,
        },
      });
      if (!invoice) throw new AppError(404, "Sale not found");
      if (invoice.status === "VOID")
        throw new AppError(409, "This sale has already been cancelled or returned");
      if (invoice.status === "DRAFT")
        throw new AppError(400, "This sale was never rung up, so there is nothing to cancel");

      // The till usually knows the shelf. When it does not, the goods came from the branch
      // this sale was rung at, which is where they go back to.
      let warehouseId = typeof req.body?.warehouseId === "string" ? req.body.warehouseId : "";
      if (!warehouseId) {
        const fallback = await prisma.warehouse.findFirst({
          where: {
            organizationId,
            ...(invoice.branchId ? { branchId: invoice.branchId } : {}),
          },
          orderBy: { createdAt: "asc" },
        });
        warehouseId = fallback?.id ?? "";
      }
      if (!warehouseId)
        throw new AppError(400, "No warehouse is available to put this stock back in");

      const isManager =
        req.roles?.some(
          (r: any) =>
            r.role.permissions.includes("*") || r.role.permissions.includes("invoices.void")
        ) ?? false;
      const isOwnSale = !!invoice.recordedById && invoice.recordedById === getUserId(req);
      if (!isManager && !isOwnSale)
        throw new AppError(403, "Only the cashier who rang this sale, or a manager, can cancel it");

      if (invoice.paidAmount > 0)
        throw new AppError(
          409,
          `${invoice.paidAmount.toFixed(2)} has already been taken on this sale. Refund it from Payments before cancelling, or void it from Invoices as a manager.`
        );

      const result = await reverseSale({
        invoiceId: invoice.id,
        organizationId,
        warehouseId,
        reason: `Cancelled at the till ${invoice.invoiceNumber}`,
      });

      await notifyPermissionHolders({
        organizationId,
        permission: "reports.view",
        title: "Sale cancelled at the till",
        body: `${invoice.invoiceNumber} cancelled before payment; stock restored`,
        type: "warning",
        link: "/dashboard/invoices",
        excludeUserIds: [getUserId(req)!],
      }).catch(() => 0);

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// Also wrapped: an async handler that throws without next kills the process rather
// than returning an error. Reading a receipt must never be able to stop the server.
posRouter.get(
  "/receipt/:invoiceId",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");
      const isOwner = req.roles?.some((r: any) => r.role.permissions.includes("*")) ?? false;
      res.json({
        data: await getReceipt(
          req.params.invoiceId,
          organizationId,
          isOwner ? undefined : req.userId
        ),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Opens the M-PESA STK prompt for a POS sale — the till half of the second rail.
 *
 * Mirrors POST /card-payments/initialize: the request carries only the phone
 * number, never an amount, because `startMpesaPosPayment` charges the invoice's
 * outstanding balance from the database. Nothing about the invoice changes here
 * either; it turns paid only when /mpesa/confirm comes back with Safaricom's own
 * answer, keyed on the CheckoutRequestID stored at push time.
 */
posRouter.post(
  "/sales/:invoiceId/mpesa",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const result = await startMpesaPosPayment({
        invoiceId: req.params.invoiceId,
        organizationId,
        phone: String(req.body?.phone ?? ""),
      });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The till asks what Safaricom decided about one M-PESA payment.
 *
 * Mirrors POST /card-payments/confirm: the browser only says "the customer may
 * have paid", and the server asks the provider — but the reference is scoped to
 * this organization first, so another shop's reference is a 404 here and never
 * a question sent to Daraja on someone else's behalf. The response carries the
 * invoice snapshot alongside the verdict, so the caller can show what the sale
 * owes now without a second round-trip.
 */
posRouter.post(
  "/mpesa/confirm",
  requireAuth,
  requirePermission("pos.sale"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = getOrganizationId(req);
      if (!organizationId) throw new AppError(401, "Authentication required");

      const reference = String(req.body?.reference ?? "");
      if (!reference) throw new AppError(400, "A payment reference is required");

      const owned = await prisma.cardPayment.findFirst({
        where: { reference, organizationId },
        select: { id: true },
      });
      if (!owned) throw new AppError(404, "Payment not found");

      const result = await confirmMpesaPosPayment(reference);

      const payment = await prisma.cardPayment.findUnique({
        where: { reference },
        select: { invoiceId: true },
      });
      const invoice = payment
        ? await prisma.invoice.findUnique({
            where: { id: payment.invoiceId },
            select: {
              invoiceNumber: true,
              status: true,
              paidAmount: true,
              total: true,
              currency: true,
            },
          })
        : null;

      res.json({ data: { ...result, invoice } });
    } catch (err) {
      next(err);
    }
  }
);
