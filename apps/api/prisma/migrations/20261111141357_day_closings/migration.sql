-- Add day_closings table for the daily closing report (v1 pilot).
-- One row per organization per calendar date. Additive only.
CREATE TABLE "DayClosing" (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "date"        TEXT NOT NULL,          -- YYYY-MM-DD in the org's timezone
  "status"      TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED | REOPENED
  "openedById"  TEXT NOT NULL REFERENCES "User"(id),
  "openedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closedById"  TEXT REFERENCES "User"(id),
  "closedAt"    TIMESTAMPTZ,
  "expectedCash" DOUBLE PRECISION,
  "countedCash"  DOUBLE PRECISION,
  "expectedMpesa" DOUBLE PRECISION,
  "countedMpesa"  DOUBLE PRECISION,
  "difference"    DOUBLE PRECISION,
  "notes"         TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "organizationId" TEXT NOT NULL REFERENCES "Organization"(id)
);

CREATE UNIQUE INDEX "DayClosing_organizationId_date_unique"
ON "DayClosing" ("organizationId", "date");

CREATE INDEX "DayClosing_organizationId_status_idx"
ON "DayClosing" ("organizationId", "status");
