-- Add product_units table for pack unit conversions (v1 pilot).
-- One row per (product, unit name). factorToBase converts pack units to base units.
-- Additive only: new table, no existing tables modified.
CREATE TABLE "ProductUnit" (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                   TEXT NOT NULL,
  "factorToBase"         INTEGER NOT NULL,
  "isDefaultSaleUnit"    BOOLEAN NOT NULL DEFAULT FALSE,
  "isDefaultPurchaseUnit" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "productId"            TEXT NOT NULL REFERENCES "Product"(id),
  "organizationId"       TEXT NOT NULL REFERENCES "Organization"(id)
);

CREATE UNIQUE INDEX "ProductUnit_productId_name_unique"
ON "ProductUnit" ("productId", "name");

CREATE INDEX "ProductUnit_productId_idx"
ON "ProductUnit" ("productId");

CREATE INDEX "ProductUnit_organizationId_idx"
ON "ProductUnit" ("organizationId");
