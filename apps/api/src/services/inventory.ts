import type { Prisma } from "@prisma/client";
import type { StockMovementType, StockStatus } from "@kazios/validation";
import { availableStock, stockStatusFor } from "@kazios/validation";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";

/** Product types that never hold stock, even when `trackStock` is enabled. */
const UNTRACKED_PRODUCT_TYPES = new Set(["SERVICE", "DIGITAL"]);

export function isStockTracked(product: { trackStock: boolean; productType: string }): boolean {
  return product.trackStock && !UNTRACKED_PRODUCT_TYPES.has(product.productType);
}

export interface StockLevel {
  quantity: number;
  reserved: number;
  available: number;
  status: StockStatus;
}

export function stockLevel(quantity: number, reserved = 0, minStock = 0): StockLevel {
  const available = availableStock(quantity, reserved);
  return { quantity, reserved, available, status: stockStatusFor(available, minStock) };
}

export async function getTrackedProduct(organizationId: string, productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId } });
  if (!product)
    throw new AppError(400, "The selected product is not available in this organization");
  if (!isStockTracked(product)) {
    throw new AppError(
      400,
      `${product.name} does not track stock, so stock cannot be adjusted or transferred`
    );
  }
  return product;
}

export async function getOrganizationWarehouse(organizationId: string, warehouseId: string) {
  const warehouse = await prisma.warehouse.findFirst({
    where: { id: warehouseId, organizationId },
    include: { branch: true },
  });
  if (!warehouse)
    throw new AppError(400, "The selected warehouse is not available in this organization");
  return warehouse;
}

export interface StockChangeResult {
  level: StockLevel;
  movement: {
    id: string;
    type: string;
    quantity: number;
    reason: string | null;
    reference: string | null;
    createdAt: Date;
  };
}

export interface StockChangeInput {
  organizationId: string;
  productId: string;
  warehouseId: string;
  branchId?: string | null;
  /** Signed change: positive receives stock, negative issues stock. */
  delta: number;
  type: StockMovementType;
  reason?: string | null;
  reference?: string | null;
  productName?: string;
}

/**
 * The single write path for stock. Every quantity change is applied to the
 * Inventory record and appended to the StockMovement ledger in the same
 * transaction, so on-hand counts and history can never drift apart.
 */
export async function applyStockChange(
  client: Prisma.TransactionClient,
  input: StockChangeInput
): Promise<StockChangeResult> {
  const delta = Number(input.delta.toFixed(4));
  if (!delta) throw new AppError(400, "Stock change must not be zero");

  const product = await client.product.findFirst({
    where: { id: input.productId, organizationId: input.organizationId },
    select: { id: true, name: true, minStock: true },
  });
  if (!product)
    throw new AppError(400, "The selected product is not available in this organization");

  const label = input.productName || product.name;
  let quantity = 0;
  let reserved = 0;

  if (delta < 0) {
    const needed = Math.abs(delta);
    const before = await client.inventory.findUnique({
      where: {
        productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId },
      },
    });
    const onHand = before?.quantity ?? 0;
    reserved = before?.reserved ?? 0;
    const available = availableStock(onHand, reserved);

    if (!before || available < needed) {
      throw new AppError(
        409,
        `Only ${available} of ${label} is available in this warehouse, ${needed} requested`
      );
    }

    const updated = await client.inventory.updateMany({
      where: {
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: { gte: needed + reserved },
      },
      data: { quantity: { decrement: needed } },
    });
    if (updated.count !== 1) {
      throw new AppError(
        409,
        `Stock for ${label} changed while processing. Review the current level and try again.`
      );
    }
    quantity = onHand - needed;
  } else {
    const after = await client.inventory.upsert({
      where: {
        productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId },
      },
      update: { quantity: { increment: delta } },
      create: {
        organizationId: input.organizationId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: delta,
      },
      select: { quantity: true, reserved: true },
    });
    quantity = after.quantity;
    reserved = after.reserved;
  }

  const movement = await client.stockMovement.create({
    data: {
      type: input.type,
      quantity: delta,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      organizationId: input.organizationId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      branchId: input.branchId ?? null,
    },
    select: {
      id: true,
      type: true,
      quantity: true,
      reason: true,
      reference: true,
      createdAt: true,
    },
  });

  return { level: stockLevel(quantity, reserved, product.minStock), movement };
}
