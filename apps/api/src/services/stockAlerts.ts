import { prisma } from "../lib/prisma";
import { stockStatusFor } from "@kazios/validation";
import { notifyPermissionHolders } from "./notifications";

/**
 * Raises a low stock alert for anything that has fallen to its reorder level.
 *
 * Called wherever stock actually moves, rather than only from a background sweep: a sale
 * is the moment a product crosses the line, and an alert that arrives with the sale is
 * worth far more to a shop than one that arrives on the next scheduled run.
 *
 * The alert is deduplicated on the product and warehouse, so a product that stays low
 * notifies once rather than on every subsequent sale.
 */
export async function alertOnLowStock(
  organizationId: string,
  productIds: string[],
  warehouseId?: string
): Promise<number> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (!ids.length) return 0;

  const levels = await prisma.inventory.findMany({
    where: {
      organizationId,
      productId: { in: ids },
      ...(warehouseId ? { warehouseId } : {}),
    },
    include: { product: true, warehouse: true },
  });

  let delivered = 0;
  for (const level of levels) {
    const { product, warehouse, quantity, reserved } = level;
    if (!product.trackStock) continue;
    if (product.minStock <= 0) continue;

    const available = Math.max(0, quantity - reserved);
    if (stockStatusFor(available, product.minStock) === "IN_STOCK") continue;

    const outOfStock = available <= 0;
    delivered += await notifyPermissionHolders({
      organizationId,
      permission: "inventory.view",
      title: outOfStock ? "Out of stock" : "Low stock",
      body: outOfStock
        ? `${product.name} has sold out in ${warehouse.name}.`
        : `${product.name} is down to ${available} in ${warehouse.name} (reorder at ${product.minStock}).`,
      type: outOfStock ? "error" : "warning",
      link: "/inventory",
      dedupeKey: `low-stock:${product.id}:${warehouse.id}`,
    });
  }
  return delivered;
}
