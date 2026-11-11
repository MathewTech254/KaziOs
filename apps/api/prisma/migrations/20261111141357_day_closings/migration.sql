-- Add day_closings table for the daily closing report (v1 pilot).
-- One row per organization per calendar date. Additive only.
CREATE TABLE "DayClosing" (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  date        TEXT NOT NULL,          -- YYYY-MM-DD in the org's timezone
  status      TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | CLOSED | REOPENED
  opened_by_id TEXT NOT NULL REFERENCES "User"(id),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by_id TEXT REFERENCES "User"(id),
  closed_at   TIMESTAMPTZ,
  expected_cash DOUBLE PRECISION,
  counted_cash  DOUBLE PRECISION,
  expected_mpesa DOUBLE PRECISION,
  counted_mpesa  DOUBLE PRECISION,
  difference    DOUBLE PRECISION,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  organizationId TEXT NOT NULL REFERENCES "Organization"(id)
);

CREATE UNIQUE INDEX "DayClosing_organizationId_date_unique"
ON "DayClosing" ("organizationId", "date");

CREATE INDEX "DayClosing_organizationId_status_idx"
ON "DayClosing" ("organizationId", "status");
