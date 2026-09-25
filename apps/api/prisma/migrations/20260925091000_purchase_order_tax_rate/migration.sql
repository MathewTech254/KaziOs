-- Keep the rate alongside the computed amount so the tax can be re-derived.
ALTER TABLE "PurchaseOrder" ADD COLUMN "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0;
