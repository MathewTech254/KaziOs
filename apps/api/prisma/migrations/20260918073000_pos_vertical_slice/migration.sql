-- Add tenant ownership to inventory records and backfill from products.
ALTER TABLE "Inventory" ADD COLUMN "organizationId" TEXT;
UPDATE "Inventory" i SET "organizationId" = p."organizationId" FROM "Product" p WHERE p."id" = i."productId";
ALTER TABLE "Inventory" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Inventory_organizationId_idx" ON "Inventory"("organizationId");

-- Add tenant ownership to stock movements and backfill from products.
ALTER TABLE "StockMovement" ADD COLUMN "organizationId" TEXT;
UPDATE "StockMovement" sm SET "organizationId" = p."organizationId" FROM "Product" p WHERE p."id" = sm."productId";
ALTER TABLE "StockMovement" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "StockMovement_organizationId_idx" ON "StockMovement"("organizationId");

-- Allow walk-in sales and idempotent POS submissions.
ALTER TABLE "Invoice" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "Invoice" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Invoice_idempotencyKey_key" ON "Invoice"("idempotencyKey");
