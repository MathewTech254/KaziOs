-- Purchase orders need a receiving warehouse, an author, money breakdown and lifecycle
-- timestamps before they can be used for real purchasing. All additions are nullable or
-- defaulted so existing rows stay valid.
ALTER TABLE "PurchaseOrder" ADD COLUMN "notes" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "currency" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN "taxTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "createdById" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PurchaseOrderItem" ADD COLUMN "description" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_status_idx" ON "PurchaseOrder"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
