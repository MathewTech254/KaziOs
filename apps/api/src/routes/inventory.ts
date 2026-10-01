import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import type { StockStatus } from "@kazios/validation";
import {
  STOCK_MOVEMENT_TYPES,
  availableStock,
  zInventoryAdjustmentSchema,
  zInventoryQuerySchema,
  zStockMovementQuerySchema,
  zStockTransferQuerySchema,
  zStockTransferSchema,
} from "@kazios/validation";
import { prisma } from "../lib/prisma";
import { requireAuth, requirePermission } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { generateStockReference, paginate } from "../lib/utils";
import { getOrganizationId, getScopedValues, getUserId, isAllowed } from "../lib/scope";
import {
  applyStockChange,
  getOrganizationWarehouse,
  getTrackedProduct,
  stockLevel,
} from "../services/inventory";
import { alertOnLowStock } from "../services/stockAlerts";

export const inventoryRouter = Router();

/** Product types that never hold stock. Kept in sync with services/inventory.ts. */
const UNTRACKED_PRODUCT_TYPES = ["SERVICE", "DIGITAL"];

/** Guard rail for the in-memory status filtering used by the stock level report. */
const MAX_LEVEL_SCAN = 2000;

const transferInclude: Prisma.StockTransferInclude = {
  product: { select: { id: true, name: true, sku: true, costPrice: true } },
  sourceWarehouse: { select: { id: true, name: true, code: true } },
  destinationWarehouse: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true } },
};

function requireOrganization(req: Request): string {
  const organizationId = getOrganizationId(req);
  if (!organizationId) throw new AppError(401, "Authentication required");
  return organizationId;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

/** Warehouses the signed-in user may see, honouring role level warehouse/branch scope. */
async function scopedWarehouses(req: Request, organizationId: string) {
  const scoped = getScopedValues(req, "warehouseId");
  return prisma.warehouse.findMany({
    where: { organizationId, ...(scoped.length ? { id: { in: scoped } } : {}) },
    include: { branch: true },
    orderBy: { name: "asc" },
  });
}

/** Reachable when the role is unrestricted, the warehouse is assigned, or its branch is assigned. */
function assertWarehouseAccess(
  req: Request,
  warehouse: { id: string; branchId: string | null }
): void {
  if (isAllowed(warehouse.id, getScopedValues(req, "warehouseId"))) return;
  if (warehouse.branchId && isAllowed(warehouse.branchId, getScopedValues(req, "branchId"))) return;
  throw new AppError(403, "You do not have access to this warehouse");
}

interface StockLevelRow {
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  costPrice: number;
  sellingPrice: number;
  minStock: number;
  reorderPoint: number;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCount: number;
  quantity: number;
  reserved: number;
  available: number;
  status: StockStatus;
  lastMovementAt: Date | null;
}

inventoryRouter.get(
  "/summary",
  requireAuth,
  requirePermission("inventory.view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const warehouses = await scopedWarehouses(req, organizationId);
      const warehouseIds = warehouses.map(warehouse => warehouse.id);

      const [records, trackedProducts, pendingTransfers, lastMovement, organization] =
        await Promise.all([
          warehouseIds.length
            ? prisma.inventory.findMany({
                where: { organizationId, warehouseId: { in: warehouseIds } },
                select: {
                  quantity: true,
                  reserved: true,
                  product: { select: { costPrice: true, minStock: true } },
                },
              })
            : Promise.resolve(
                [] as {
                  quantity: number;
                  reserved: number;
                  product: { costPrice: number; minStock: number };
                }[]
              ),
          prisma.product.count({
            where: {
              organizationId,
              isActive: true,
              trackStock: true,
              productType: { notIn: UNTRACKED_PRODUCT_TYPES },
            },
          }),
          prisma.stockTransfer.count({ where: { organizationId, status: "PENDING" } }),
          prisma.stockMovement.findFirst({
            where: { organizationId },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
          prisma.organization.findUnique({
            where: { id: organizationId },
            select: { currency: true },
          }),
        ]);

      let totalUnits = 0;
      let reservedUnits = 0;
      let stockValue = 0;
      let lowStockCount = 0;
      let outOfStockCount = 0;

      for (const record of records) {
        const available = availableStock(record.quantity, record.reserved);
        totalUnits += record.quantity;
        reservedUnits += record.reserved;
        stockValue += record.quantity * record.product.costPrice;
        if (available <= 0) outOfStockCount += 1;
        else if (available <= record.product.minStock) lowStockCount += 1;
      }

      res.json({
        data: {
          totals: {
            warehouseCount: warehouses.length,
            trackedProducts,
            totalUnits: round(totalUnits),
            reservedUnits: round(reservedUnits),
            availableUnits: round(availableStock(totalUnits, reservedUnits)),
            stockValue: round(stockValue, 2),
            lowStockCount,
            outOfStockCount,
            pendingTransfers,
            lastMovementAt: lastMovement?.createdAt ?? null,
          },
          warehouses: warehouses.map(warehouse => ({
            id: warehouse.id,
            name: warehouse.name,
            code: warehouse.code,
            branchId: warehouse.branchId,
            branchName: warehouse.branch?.name ?? null,
          })),
          currency: organization?.currency ?? "USD",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Stock levels. When `warehouseId` is supplied the report is per product for that
 * warehouse (products with no record report zero); otherwise every product is
 * aggregated across all warehouses the user can see.
 */
inventoryRouter.get(
  "/",
  requireAuth,
  requirePermission("inventory.view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const query = zInventoryQuerySchema.parse(req.query);
      const warehouses = await scopedWarehouses(req, organizationId);

      let singleWarehouse: (typeof warehouses)[number] | null = null;
      if (query.warehouseId) {
        singleWarehouse = warehouses.find(warehouse => warehouse.id === query.warehouseId) ?? null;
        if (!singleWarehouse) throw new AppError(403, "You do not have access to this warehouse");
      }

      const targetWarehouses = singleWarehouse ? [singleWarehouse] : warehouses;
      const targetIds = targetWarehouses.map(warehouse => warehouse.id);
      const { page, limit } = query;

      if (!targetIds.length) {
        res.json({
          data: [],
          meta: {
            page,
            limit,
            total: 0,
            totalPages: 0,
            scope: "ORGANIZATION",
            warehouseId: null,
            truncated: false,
          },
        });
        return;
      }

      const products = await prisma.product.findMany({
        where: {
          organizationId,
          isActive: true,
          trackStock: true,
          productType: { notIn: UNTRACKED_PRODUCT_TYPES },
          ...(query.productId ? { id: query.productId } : {}),
          ...(query.categoryId
            ? { productCategories: { some: { categoryId: query.categoryId } } }
            : {}),
          ...(query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: "insensitive" as const } },
                  { sku: { contains: query.search, mode: "insensitive" as const } },
                  { barcode: { contains: query.search, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          costPrice: true,
          sellingPrice: true,
          minStock: true,
          reorderPoint: true,
          unit: { select: { name: true, code: true } },
          inventories: {
            where: { warehouseId: { in: targetIds } },
            select: { warehouseId: true, quantity: true, reserved: true },
          },
        },
        orderBy: { name: "asc" },
        take: MAX_LEVEL_SCAN,
      });

      const lastMovements = await prisma.stockMovement.groupBy({
        by: ["productId"],
        where: { organizationId, productId: { in: products.map(product => product.id) } },
        _max: { createdAt: true },
      });
      const lastMovementByProduct = new Map(
        lastMovements.map(row => [row.productId, row._max.createdAt ?? null])
      );

      const rows: StockLevelRow[] = products.map(product => {
        const base = {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          unit: product.unit?.code ?? product.unit?.name ?? null,
          costPrice: product.costPrice,
          sellingPrice: product.sellingPrice,
          minStock: product.minStock,
          reorderPoint: product.reorderPoint,
          lastMovementAt: lastMovementByProduct.get(product.id) ?? null,
        };

        if (singleWarehouse) {
          const record = product.inventories.find(row => row.warehouseId === singleWarehouse.id);
          return {
            ...base,
            warehouseId: singleWarehouse.id,
            warehouseName: singleWarehouse.name,
            warehouseCount: record ? 1 : 0,
            ...stockLevel(record?.quantity ?? 0, record?.reserved ?? 0, product.minStock),
          };
        }

        const quantity = product.inventories.reduce((total, row) => total + row.quantity, 0);
        const reserved = product.inventories.reduce((total, row) => total + row.reserved, 0);
        return {
          ...base,
          warehouseId: null,
          warehouseName: null,
          warehouseCount: product.inventories.length,
          ...stockLevel(quantity, reserved, product.minStock),
        };
      });

      const filtered =
        query.status === "ALL" ? rows : rows.filter(row => row.status === query.status);
      const skip = (page - 1) * limit;

      res.json({
        data: filtered.slice(skip, skip + limit),
        meta: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
          scope: singleWarehouse ? "WAREHOUSE" : "ORGANIZATION",
          warehouseId: singleWarehouse?.id ?? null,
          truncated: products.length === MAX_LEVEL_SCAN,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Append-only stock movement ledger. */
inventoryRouter.get(
  "/movements",
  requireAuth,
  requirePermission("inventory.view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const query = zStockMovementQuerySchema.parse(req.query);
      const warehouses = await scopedWarehouses(req, organizationId);
      const warehouseIds = warehouses.map(warehouse => warehouse.id);

      if (query.warehouseId && !warehouseIds.includes(query.warehouseId)) {
        throw new AppError(403, "You do not have access to this warehouse");
      }

      const { skip, take, page, limit } = paginate(query.page, query.limit);
      const where: Prisma.StockMovementWhereInput = {
        organizationId,
        warehouseId: query.warehouseId ? query.warehouseId : { in: warehouseIds },
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [data, total] = await Promise.all([
        prisma.stockMovement.findMany({
          where,
          include: {
            product: { select: { id: true, name: true, sku: true } },
            warehouse: { select: { id: true, name: true, code: true } },
            branch: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.stockMovement.count({ where }),
      ]);

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          types: STOCK_MOVEMENT_TYPES,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Manual stock adjustment (stock count correction, write-off, opening balance). */
inventoryRouter.post(
  "/adjustments",
  requireAuth,
  requirePermission("inventory.manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const input = zInventoryAdjustmentSchema.parse(req.body);
      const product = await getTrackedProduct(organizationId, input.productId);
      const warehouse = await getOrganizationWarehouse(organizationId, input.warehouseId);
      assertWarehouseAccess(req, warehouse);

      const delta = input.adjustmentType === "INCREASE" ? input.quantity : -input.quantity;
      const reference = input.reference?.trim() || generateStockReference("ADJ");

      const result = await prisma.$transaction(
        tx =>
          applyStockChange(tx, {
            organizationId,
            productId: product.id,
            warehouseId: warehouse.id,
            branchId: warehouse.branchId,
            delta,
            type: "ADJUSTMENT",
            reason: input.reason.trim(),
            reference,
            productName: product.name,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      // An adjustment can push a product under its reorder level just as easily as a sale
      // can, so the same alert applies here.
      await alertOnLowStock(organizationId, [product.id], warehouse.id).catch(() => 0);

      res.status(201).json({
        data: {
          ...result,
          direction: input.adjustmentType,
          product: { id: product.id, name: product.name, sku: product.sku },
          warehouse: { id: warehouse.id, name: warehouse.name, code: warehouse.code },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

inventoryRouter.get(
  "/transfers",
  requireAuth,
  requirePermission("inventory.view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const query = zStockTransferQuerySchema.parse(req.query);
      const warehouses = await scopedWarehouses(req, organizationId);
      const warehouseIds = warehouses.map(warehouse => warehouse.id);

      if (query.warehouseId && !warehouseIds.includes(query.warehouseId)) {
        throw new AppError(403, "You do not have access to this warehouse");
      }

      const { skip, take, page, limit } = paginate(query.page, query.limit);
      const warehouseCondition = query.warehouseId
        ? {
            OR: [
              { sourceWarehouseId: query.warehouseId },
              { destinationWarehouseId: query.warehouseId },
            ],
          }
        : {
            OR: [
              { sourceWarehouseId: { in: warehouseIds } },
              { destinationWarehouseId: { in: warehouseIds } },
            ],
          };

      const where: Prisma.StockTransferWhereInput = {
        organizationId,
        ...(query.status !== "ALL" ? { status: query.status } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...warehouseCondition,
      };

      const [data, total, pending] = await Promise.all([
        prisma.stockTransfer.findMany({
          where,
          include: transferInclude,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.stockTransfer.count({ where }),
        prisma.stockTransfer.count({ where: { organizationId, status: "PENDING" } }),
      ]);

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          pending,
          statuses: ["PENDING", "COMPLETED", "CANCELLED"],
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/** Raise a transfer request. Stock only moves once the transfer is completed. */
inventoryRouter.post(
  "/transfers",
  requireAuth,
  requirePermission("inventory.manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const input = zStockTransferSchema.parse(req.body);

      if (input.sourceWarehouseId === input.destinationWarehouseId) {
        throw new AppError(400, "Source and destination warehouses must be different");
      }

      const product = await getTrackedProduct(organizationId, input.productId);
      const source = await getOrganizationWarehouse(organizationId, input.sourceWarehouseId);
      const destination = await getOrganizationWarehouse(
        organizationId,
        input.destinationWarehouseId
      );
      assertWarehouseAccess(req, source);
      assertWarehouseAccess(req, destination);

      const record = await prisma.inventory.findUnique({
        where: { productId_warehouseId: { productId: product.id, warehouseId: source.id } },
      });
      const available = availableStock(record?.quantity ?? 0, record?.reserved ?? 0);
      if (available < input.quantity) {
        throw new AppError(
          409,
          `Only ${available} of ${product.name} is available in ${source.name}, ${input.quantity} requested`
        );
      }

      const transfer = await prisma.stockTransfer.create({
        data: {
          quantity: input.quantity,
          reference: input.reference?.trim() || generateStockReference("TRF"),
          status: "PENDING",
          notes: input.notes?.trim() || null,
          organizationId,
          sourceWarehouseId: source.id,
          destinationWarehouseId: destination.id,
          productId: product.id,
          createdById: getUserId(req) ?? null,
        },
        include: transferInclude,
      });

      res.status(201).json({ data: transfer });
    } catch (err) {
      next(err);
    }
  }
);

/** Move the stock: issue from the source and receive at the destination atomically. */
inventoryRouter.post(
  "/transfers/:id/complete",
  requireAuth,
  requirePermission("inventory.manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const transfer = await prisma.stockTransfer.findFirst({
        where: { id: req.params.id, organizationId },
        include: {
          product: { select: { id: true, name: true } },
          sourceWarehouse: true,
          destinationWarehouse: true,
        },
      });
      if (!transfer) throw new AppError(404, "Transfer not found");

      assertWarehouseAccess(req, transfer.sourceWarehouse);
      assertWarehouseAccess(req, transfer.destinationWarehouse);
      if (transfer.status !== "PENDING") {
        throw new AppError(409, `This transfer is already ${transfer.status.toLowerCase()}`);
      }

      const reference = transfer.reference || transfer.id;
      const result = await prisma.$transaction(
        async tx => {
          // Claim the transfer first so it can never be completed twice.
          const claimed = await tx.stockTransfer.updateMany({
            where: { id: transfer.id, status: "PENDING" },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
          if (claimed.count !== 1) throw new AppError(409, "This transfer was already processed");

          const issued = await applyStockChange(tx, {
            organizationId,
            productId: transfer.productId,
            warehouseId: transfer.sourceWarehouseId,
            branchId: transfer.sourceWarehouse.branchId,
            delta: -transfer.quantity,
            type: "TRANSFER_OUT",
            reason: `Transfer to ${transfer.destinationWarehouse.name}`,
            reference,
            productName: transfer.product.name,
          });
          const received = await applyStockChange(tx, {
            organizationId,
            productId: transfer.productId,
            warehouseId: transfer.destinationWarehouseId,
            branchId: transfer.destinationWarehouse.branchId,
            delta: transfer.quantity,
            type: "TRANSFER_IN",
            reason: `Transfer from ${transfer.sourceWarehouse.name}`,
            reference,
            productName: transfer.product.name,
          });

          const updated = await tx.stockTransfer.findUnique({
            where: { id: transfer.id },
            include: transferInclude,
          });
          return { transfer: updated, source: issued.level, destination: received.level };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      // Stock has physically moved between the two warehouses, so both sides can now be
      // under their reorder level: the source because it gave stock away.
      await alertOnLowStock(organizationId, [transfer.productId], transfer.sourceWarehouseId).catch(
        () => 0
      );

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** Cancel a pending transfer. Nothing was deducted yet, so no stock is returned. */
inventoryRouter.post(
  "/transfers/:id/cancel",
  requireAuth,
  requirePermission("inventory.manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organizationId = requireOrganization(req);
      const transfer = await prisma.stockTransfer.findFirst({
        where: { id: req.params.id, organizationId },
        include: { sourceWarehouse: true, destinationWarehouse: true },
      });
      if (!transfer) throw new AppError(404, "Transfer not found");

      assertWarehouseAccess(req, transfer.sourceWarehouse);
      assertWarehouseAccess(req, transfer.destinationWarehouse);
      if (transfer.status !== "PENDING") {
        throw new AppError(409, `This transfer is already ${transfer.status.toLowerCase()}`);
      }

      const cancelled = await prisma.stockTransfer.updateMany({
        where: { id: transfer.id, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
      if (cancelled.count !== 1) throw new AppError(409, "This transfer was already processed");

      const data = await prisma.stockTransfer.findUnique({
        where: { id: transfer.id },
        include: transferInclude,
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);
