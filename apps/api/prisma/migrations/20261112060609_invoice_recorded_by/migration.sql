-- Add recordedById to Invoice for tracking which user created each sale.
-- Additive only: new nullable column, no existing data affected.
ALTER TABLE "Invoice" ADD COLUMN "recordedById" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"(id);
CREATE INDEX "Invoice_recordedById_idx" ON "Invoice" ("recordedById");
