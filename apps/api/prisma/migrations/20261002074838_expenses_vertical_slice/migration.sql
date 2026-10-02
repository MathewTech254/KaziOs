-- Fixes a live multi-tenancy defect: a global unique index on Setting.key.
--
-- The init migration created `CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"(key)`,
-- which is an INDEX, not a CONSTRAINT. When settings were later scoped to an
-- organization, the corrective migration used:
--
--     ALTER TABLE "Setting" DROP CONSTRAINT IF EXISTS "Setting_key_key";
--
-- Postgres raised no error because of IF EXISTS, so the statement succeeded while doing
-- nothing at all, and the index survived. The correct statement for an index is
-- DROP INDEX, which is what the Prisma schema itself now describes.
--
-- The effect is that only one organization in the entire installation can hold a setting
-- for a given key. Verified against the running database before this migration:
--
--     INSERT INTO "Setting" (id, key, value, "organizationId")
--     VALUES ('probe-org2', 'pos', '{}'::jsonb, '<other tenant>');
--     ERROR: duplicate key value violates unique constraint "Setting_key_key"
--     DETAIL: Key (key)=(pos) already exists.
--
-- So the first business to save its POS settings locked every other business on the
-- platform out of saving theirs, and their save failed with a 500. The intended
-- per-tenant uniqueness, Setting_organizationId_key_key, is already present and stays in
-- place, so dropping the global index is what restores isolation, not weakens it.
--
-- Safe to apply: no rows are read, written or deleted here, and the replacement unique
-- index already exists, so uniqueness within a tenant is preserved throughout.
DROP INDEX IF EXISTS "Setting_key_key";

-- ============================================================================
-- Expenses vertical slice.
--
-- Expenses existed as a table with no API, no UI and no reports, so a business could
-- not record what it spent. This adds the category model, the approval and reversal
-- fields, and the indexes the new listing queries need.
--
-- Ordering matters below: the category backfill in step 3 MUST run before the foreign
-- key in step 5.
-- ============================================================================

-- Additive columns. Every one is nullable or carries a default, so existing rows
-- survive untouched and read as RECORDED expenses with no approver and no void.
ALTER TABLE "Expense"
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'RECORDED',
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3);

CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "accountCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- Per-tenant uniqueness: two businesses may each have a category called "Rent", which
-- is the whole point of scoping it. A global unique index on the name is what made the
-- second business on the platform unable to save anything, so this is deliberately
-- composite rather than a bare name index.
CREATE UNIQUE INDEX "ExpenseCategory_organizationId_name_key" ON "ExpenseCategory"("organizationId", "name");

-- ---------------------------------------------------------------------------
-- Backfill the categories the existing expenses already referred to.
--
-- Expense.categoryId was a bare string column with no table behind it, and the demo
-- business had been using it as a free text label: the live rows held 'Rent',
-- 'Utilities' and 'Salaries'. Turning that column into a foreign key without
-- reconciling it first fails the whole migration with
--     ERROR: violates foreign key constraint "Expense_categoryId_fkey"
-- which is exactly what happened on the first attempt at this migration.
--
-- So the labels are promoted into real category rows first, preserving both the tenant
-- that owns them and the spend that references them. Nothing is deleted and no amount
-- changes: an existing expense keeps its category, its amount and its date, and only
-- gains a proper relation to it.
--
-- The id is derived from the tenant and the label, so re-running this migration
-- cannot duplicate a category.
-- ---------------------------------------------------------------------------
INSERT INTO "ExpenseCategory" ("id", "name", "description", "accountCode", "organizationId")
SELECT
    md5(e."organizationId" || ':' || e."categoryId"),
    e."categoryId",
    'Migrated from a free text expense category',
    NULL,
    e."organizationId"
FROM "Expense" e
WHERE e."categoryId" IS NOT NULL
  AND btrim(e."categoryId") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "ExpenseCategory" c
    WHERE c."organizationId" = e."organizationId" AND c.name = e."categoryId"
  )
GROUP BY e."organizationId", e."categoryId";

-- Point each expense at the category row that now carries its label.
UPDATE "Expense" e
SET "categoryId" = c."id"
FROM "ExpenseCategory" c
WHERE c."organizationId" = e."organizationId"
  AND c.name = e."categoryId"
  AND e."categoryId" IS DISTINCT FROM c."id";

-- Indexes for the listing and reporting queries, which filter by tenant and date and
-- group by category. Without them every expense report is a sequential scan.
CREATE INDEX "Expense_organizationId_expenseDate_idx" ON "Expense"("organizationId", "expenseDate");
CREATE INDEX "Expense_organizationId_categoryId_idx" ON "Expense"("organizationId", "categoryId");

-- Constraints, applied only after the backfill above so they cannot reject a row that
-- is still carrying a label.
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

