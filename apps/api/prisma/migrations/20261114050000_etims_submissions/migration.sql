-- The KRA outbox for eTIMS. One row per invoice, written at sale time whether or not
-- KRA is reachable, so a VAT-registered business can prove it filed — or that it is
-- still trying. Additive: a new table only, nothing existing is touched.
--
-- Every statement is guarded so this is safe to re-run. The migration was applied by hand
-- while the eTIMS credentials were still being issued, and `migrate deploy` replays this
-- file on the next deploy; without the guards that replay would fail on "already exists"
-- and take the deploy with it.

CREATE TABLE IF NOT EXISTS "EtimsSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "kraInvoiceNumber" TEXT,
    "qrCode" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EtimsSubmission_pkey" PRIMARY KEY ("id")
);

-- One row per invoice: a sale is filed once, not once per retry.
CREATE UNIQUE INDEX IF NOT EXISTS "EtimsSubmission_invoiceId_key" ON "EtimsSubmission" ("invoiceId");

-- The worker sweeps by status, and the admin screen lists by organization.
CREATE INDEX IF NOT EXISTS "EtimsSubmission_organizationId_status_idx" ON "EtimsSubmission" ("organizationId", "status");
CREATE INDEX IF NOT EXISTS "EtimsSubmission_status_attempts_idx" ON "EtimsSubmission" ("status", "attempts");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so each one is guarded by name.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EtimsSubmission_organizationId_fkey'
    ) THEN
        ALTER TABLE "EtimsSubmission"
            ADD CONSTRAINT "EtimsSubmission_organizationId_fkey"
            FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'EtimsSubmission_invoiceId_fkey'
    ) THEN
        ALTER TABLE "EtimsSubmission"
            ADD CONSTRAINT "EtimsSubmission_invoiceId_fkey"
            FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;