-- Prevent duplicate M-PESA manual transaction codes within an organization.
--
-- MPESA_MANUAL is a new payment rail (added in Step 4), so no existing rows
-- should use provider = 'MPESA_MANUAL'. Before applying this migration on a
-- production database, verify no duplicates exist:
--
--   SELECT organizationId, providerRef, count(*)
--   FROM "Payment"
--   WHERE provider = 'MPESA_MANUAL'
--   GROUP BY organizationId, providerRef
--   HAVING count(*) > 1;
--
-- If any rows are returned, deduplicate them before applying this migration.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_mpesa_manual_unique"
ON "Payment" ("organizationId", "providerRef")
WHERE "provider" = 'MPESA_MANUAL';
