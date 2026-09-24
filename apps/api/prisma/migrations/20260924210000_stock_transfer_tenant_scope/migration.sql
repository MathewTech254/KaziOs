-- Tenant ownership and lifecycle metadata for stock transfers.
ALTER TABLE "StockTransfer" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "StockTransfer" ADD COLUMN "notes" TEXT;
ALTER TABLE "StockTransfer" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "StockTransfer" ADD COLUMN "createdById" TEXT;

-- Backfill tenant ownership from the source warehouse, then the product as a fallback.
UPDATE "StockTransfer" st SET "organizationId" = w."organizationId"
FROM "Warehouse" w WHERE w."id" = st."sourceWarehouseId";

UPDATE "StockTransfer" st SET "organizationId" = p."organizationId"
FROM "Product" p WHERE p."id" = st."productId" AND st."organizationId" IS NULL;

ALTER TABLE "StockTransfer" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "StockTransfer_organizationId_idx" ON "StockTransfer"("organizationId");

-- CreateIndex
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
