import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { generatePoNumber } from "../lib/utils";

export interface OrderLineInput {
  productId: string;
  quantity: number;
  unitPrice: number;
  description?: string | null;
}

export interface OrderTotals {
  lines: Array<OrderLineInput & { lineTotal: number }>;
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  totalAmount: number;
}

const round2 = (value: number): number => Number(value.toFixed(2));

/** Every amount on a purchase order is derived here, never taken from the request. */
export function calculateOrderTotals(items: OrderLineInput[], taxRate = 0): OrderTotals {
  const lines = items.map((item) => ({ ...item, lineTotal: round2(item.quantity * item.unitPrice) }));
  const subtotal = round2(lines.reduce((total, line) => total + line.lineTotal, 0));
  const safeRate = Number.isFinite(taxRate) ? taxRate : 0;
  const taxTotal = round2((subtotal * safeRate) / 100);
  return { lines, subtotal, taxRate: safeRate, taxTotal, totalAmount: round2(subtotal + taxTotal) };
}

export async function assertSupplierInOrg(organizationId: string, supplierId: string): Promise<void> {
  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, organizationId }, select: { id: true } });
  if (!supplier) throw new AppError(400, "The selected supplier is not available in this organization");
}

export async function assertWarehouseInOrg(
  organizationId: string,
  warehouseId?: string | null
): Promise<void> {
  if (!warehouseId) return;
  const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId }, select: { id: true } });
  if (!warehouse) throw new AppError(400, "The selected warehouse is not available in this organization");
}

/** Refuses products from another organization, and products listed twice. */
export async function assertOrderItemsValid(
  organizationId: string,
  items: OrderLineInput[]
): Promise<void> {
  const productIds = items.map((item) => item.productId);
  const uniqueIds = Array.from(new Set(productIds));
  if (uniqueIds.length !== productIds.length) {
    throw new AppError(400, "The same product is listed more than once", "DUPLICATE_PRODUCT");
  }

  const count = await prisma.product.count({ where: { id: { in: uniqueIds }, organizationId } });
  if (count !== uniqueIds.length) {
    throw new AppError(400, "One or more products are not available in this organization");
  }
}

/** poNumber is globally unique; retry a few times in the unlikely event of a clash. */
export async function generateUniquePoNumber(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const candidate = generatePoNumber();
      const exists = await prisma.purchaseOrder.findUnique({ where: { poNumber: candidate }, select: { id: true } });
      if (!exists) return candidate;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new AppError(500, "Could not allocate a purchase order number, please try again");
}
