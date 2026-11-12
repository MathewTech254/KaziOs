-- Add stocktake tables for stock control (v1 pilot).
-- StockCount: one count session per organization/warehouse.
-- StockCountLine: per-product counted quantities within a count.
-- Additive only: new tables, no existing tables modified.

CREATE TABLE "StockCount" (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  status      TEXT NOT NULL DEFAULT 'OPEN',
  warehouseId TEXT REFERENCES "Warehouse"(id),
  openedById  TEXT NOT NULL REFERENCES "User"(id),
  openedAt    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmedById TEXT REFERENCES "User"(id),
  confirmedAt   TIMESTAMPTZ,
  notes         TEXT,
  organizationId TEXT NOT NULL REFERENCES "Organization"(id),
  createdAt     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "StockCountLine" (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  countId     TEXT NOT NULL REFERENCES "StockCount"(id),
  productId   TEXT NOT NULL REFERENCES "Product"(id),
  expectedQty DECIMAL(65,30) NOT NULL DEFAULT 0,
  countedQty  DECIMAL(65,30) NOT NULL DEFAULT 0,
  diffQty     DECIMAL(65,30) NOT NULL DEFAULT 0,
  diffAmount  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  createdAt   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "StockCount_organizationId_status_idx"
ON "StockCount" ("organizationId", "status");

CREATE INDEX "StockCount_warehouseId_idx"
ON "StockCount" ("warehouseId");

CREATE INDEX "StockCountLine_countId_idx"
ON "StockCountLine" ("countId");

CREATE INDEX "StockCountLine_productId_idx"
ON "StockCountLine" ("productId");

CREATE UNIQUE INDEX "StockCountLine_countId_productId_unique"
ON "StockCountLine" ("countId", "productId");
