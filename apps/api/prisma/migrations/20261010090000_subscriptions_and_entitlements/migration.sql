-- Subscriptions and entitlements.
--
-- The Subscription table that existed here was a stub: a planId string with no plan to
-- point at, a billing cycle column nothing wrote, and no payments, no history and no
-- limits. It could record that someone had a plan and could not say what the plan was,
-- what it cost, whether the money arrived, or when it ran out.
--
-- This migration builds the thing that can answer those questions:
--
--   Feature  -> what a business can do        (a closed catalog, enforced by the API)
--   Plan     -> what is sold                  (rows, so an administrator can re-price)
--   PlanFeature / PlanLimit -> what a plan grants
--   PlanPrice -> what it costs, per interval
--   Subscription -> what one business actually holds, and until when
--   SubscriptionEvent -> append only history of how it got there
--   SubscriptionPayment -> invoices and payment records
--   UsageRecord -> metered consumption, per period
--   EntitlementOverride -> an attributable exception above a plan
--   PlatformAdmin -> platform authority, separate from any business role
--
-- Safe to apply: no business data is read, written or deleted. Existing organizations
-- and subscriptions are backfilled onto the Community plan, which is the plan a new
-- business already gets for free, so nothing that works today stops working.
--
-- Ordering below is load bearing:
--   1. create the catalogue tables
--   2. seed them
--   3. widen Subscription and backfill it onto the seeded plan
--   4. only then add the foreign keys that depend on those values

-- ============================================================================
-- 1. The catalogue
-- ============================================================================

CREATE TABLE "Feature" (
    "key"         TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "available"   BOOLEAN NOT NULL DEFAULT false,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Feature_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "Plan" (
    "id"                   TEXT NOT NULL,
    "key"                  TEXT NOT NULL,
    "name"                 TEXT NOT NULL,
    "description"          TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'ACTIVE',
    "visibility"           TEXT NOT NULL DEFAULT 'PUBLIC',
    "isDefault"            BOOLEAN NOT NULL DEFAULT false,
    "sortOrder"            INTEGER NOT NULL DEFAULT 0,
    "isFree"               BOOLEAN NOT NULL DEFAULT false,
    "trialDays"            INTEGER NOT NULL DEFAULT 0,
    "yearlyPerMonthCents"  INTEGER,
    "highlight"            TEXT,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");
CREATE INDEX "Plan_status_visibility_sortOrder_idx" ON "Plan"("status", "visibility", "sortOrder");

CREATE TABLE "PlanPrice" (
    "id"          TEXT NOT NULL,
    "planId"      TEXT NOT NULL,
    "interval"    TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'USD',
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanPrice_planId_interval_currency_key" ON "PlanPrice"("planId", "interval", "currency");
CREATE INDEX "PlanPrice_planId_isActive_idx" ON "PlanPrice"("planId", "isActive");

CREATE TABLE "PlanFeature" (
    "id"         TEXT NOT NULL,
    "planId"     TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    CONSTRAINT "PlanFeature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanFeature_planId_featureKey_key" ON "PlanFeature"("planId", "featureKey");
CREATE INDEX "PlanFeature_featureKey_idx" ON "PlanFeature"("featureKey");

CREATE TABLE "PlanLimit" (
    "id"     TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key"    TEXT NOT NULL,
    "value"  INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "unit"   TEXT NOT NULL DEFAULT 'count',
    "period" TEXT NOT NULL DEFAULT 'never',
    CONSTRAINT "PlanLimit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlanLimit_planId_key_key" ON "PlanLimit"("planId", "key");
CREATE INDEX "PlanLimit_key_idx" ON "PlanLimit"("key");

-- ============================================================================
-- 2. Seed the catalogue
--
-- The feature catalog is seeded with available = true only where this repository
-- contains code that actually enforces it. That column is the honesty guard for the
-- pricing page: a feature can exist here, be granted by a plan and be checked by the
-- API long before it has a screen a customer can reach, and listing it before then
-- would be advertising something that cannot be bought and used.
--
-- Rows seeded with available = false are the vocabulary for features that are not
-- sellable yet. They are intentionally not advertised. Promoting one is a deliberate
-- one line change once its enforcement exists.
--
-- The ids are fixed rather than generated so this migration is idempotent and so a
-- reinstall of the catalogue lands on the same rows.
-- ============================================================================

-- Core: the open source product. Present on every plan and never gated. A self hosted
-- KaziOS has to remain a complete business, not a demo, so no plan takes the till, the
-- products or the customers away.
INSERT INTO "Feature" ("key", "name", "description", "category", "available", "sortOrder") VALUES
    ('core_pos',         'Point of sale',           'Ring up sales, take payment and print receipts.',                                  'CORE', true, 1),
    ('core_products',    'Products and stock',      'Products, prices, stock levels and stock movement history.',                          'CORE', true, 2),
    ('core_customers',   'Customers',               'Customer records, balances and purchase history.',                                  'CORE', true, 3),
    ('core_inventory',   'Inventory',               'Warehouses, stock levels, transfers and low stock alerts.',                          'CORE', true, 4),
    ('core_purchasing',  'Purchasing',              'Purchase orders, suppliers and goods receipts.',                                    'CORE', true, 5),
    ('core_reports',     'Reports',                 'Dashboard, sales summary and workspace search.',                                    'CORE', true, 6),
    ('core_roles',       'Roles and permissions',   'Per branch roles and permissions for your team.',                                    'CORE', true, 7),
    ('core_self_hosting','Self hosting',            'Run the whole system on your own infrastructure.',                                  'CORE', true, 8),
    ('accounting',       'Accounting and expenses', 'Record business spend, approvals and the ledger behind each sale.',                  'CORE', true, 9),

    -- Below here: the commercial capabilities.
    ('multi_branch',       'Multiple branches',   'Trade from more than one location, each with its own stock and reporting.',  'OPERATIONS',   true,  20),
    ('advanced_inventory', 'Advanced inventory', 'Multi warehouse stock transfers and deeper stock control.',                    'OPERATIONS',   false, 21),
    ('advanced_reports',   'Advanced reports',   'Scheduled and cross branch reporting.',                                       'INTELLIGENCE', false, 22),
    ('automation',         'Automation',         'Rules that act on sales, stock and payments without you doing it.',           'OPERATIONS',   false, 23),
    ('api_access',         'API access',         'Programmatic access to your KaziOS data through the API.',                     'PLATFORM',     false, 24),
    ('ai_assistant',       'AI assistant',       'AI help with your catalogue, stock and numbers.',                              'INTELLIGENCE', false, 25),
    ('whatsapp',           'WhatsApp',           'Send receipts and updates to customers over WhatsApp.',                       'OPERATIONS',   false, 26),
    ('managed_backups',    'Managed backups',    'Automatic off site backups, tested and restorable.',                           'PLATFORM',     false, 27),
    ('managed_whatsapp',   'Managed messaging',  'Managed WhatsApp and SMS delivery, billed per conversation.',                 'PLATFORM',     false, 28),
    ('sso',                'Single sign on',     'SAML and OIDC sign in with your own identity provider.',                       'PLATFORM',     false, 29),
    ('audit_export',       'Audit log export',   'Export the full audit trail for your own compliance reporting.',              'PLATFORM',     false, 30),
    ('priority_support',   'Priority support',   'Faster response on support requests.',                                         'SUPPORT',      false, 31),
    ('dedicated_support',  'Dedicated support',  'A named contact who knows your business.',                                    'SUPPORT',      false, 32),
    ('custom_limits',      'Custom limits',      'Agreements tailored to your volume.',                                           'PLATFORM',     false, 33)
ON CONFLICT ("key") DO NOTHING;

-- Prices are integer minor units of the price's own currency. Currency lives on the
-- price row rather than on a global setting, so a plan can be sold in more than one
-- currency without a second plan existing for each.
--
-- The yearly amount is deliberately not "monthly x 12". Two months free is how the
-- yearly figure is arrived at, and writing the real number here means the page and the
-- charge can never disagree about what a year costs.
INSERT INTO "Plan" ("id", "key", "name", "description", "status", "visibility", "isDefault", "sortOrder", "isFree", "trialDays", "yearlyPerMonthCents", "highlight") VALUES
    ('00000000-0000-4000-8000-000000000001', 'community',  'Community',  'The whole of KaziOS, self hosted, for one shop trading at one location.',  'ACTIVE', 'PUBLIC',  true,  1, true,  0,  NULL,  'Free forever, not a trial.'),
    ('00000000-0000-4000-8000-000000000002', 'starter',    'Starter',    'For a growing shop that needs a second location and a bigger team.',        'ACTIVE', 'PUBLIC',  false, 2, false, 14, 1583, 'Two weeks free to begin.'),
    ('00000000-0000-4000-8000-000000000003', 'business',   'Business',   'For a business trading across several locations with a team behind it.',     'ACTIVE', 'PUBLIC',  false, 3, false, 14, 4917, 'Scale without the ceiling.'),
    ('00000000-0000-4000-8000-000000000004', 'enterprise', 'Enterprise', 'For groups that need their own limits, their own controls and their own support.','ACTIVE','PRIVATE', false, 4, false, 0, NULL,   'Quoted to your requirements.')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlanPrice" ("id", "planId", "interval", "amountCents", "currency", "isActive") VALUES
    ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'monthly', 0,     'USD', true),
    ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'monthly', 1900,  'USD', true),
    ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000002', 'yearly',  19000, 'USD', true),
    ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000003', 'monthly', 5900,  'USD', true),
    ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000003', 'yearly',  59000, 'USD', true)
ON CONFLICT ("planId", "interval", "currency") DO NOTHING;

-- Enterprise deliberately has no PlanPrice row. It is quoted rather than sold from a
-- page, and a row with an amount of 0 would be read as "free" by anything that sums
-- prices, which is precisely the mistake this table exists to make impossible.

-- Community gets the whole core. It is the open source product, so the grant is
-- expressed once here and inherited by "every plan holds the core", rather than being
-- copied onto each plan where a later core feature would have to be remembered four
-- times. The service treats every CORE category feature as granted regardless of this
-- table; these rows exist so the catalogue and the pricing page agree.
INSERT INTO "PlanFeature" ("id", "planId", "featureKey")
SELECT gen_random_uuid()::text, p."id", f."key"
FROM "Plan" p, "Feature" f
WHERE f."category" = 'CORE'
ON CONFLICT DO NOTHING;

-- multi_branch is the first commercial capability, and it is the one the code in this
-- repository actually enforces: creating a second branch is refused on Community with an
-- explanation and an upgrade path. Everything the pricing page claims about Community
-- versus Starter has to be visible here or it is not true.
INSERT INTO "PlanFeature" ("id", "planId", "featureKey") VALUES
    ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002', 'multi_branch'),
    ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000003', 'multi_branch'),
    ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000004', 'multi_branch'),

    -- Granted ahead of their screens on purpose: these are already sellable in the model
    -- and already gated by the API, and they are withheld from the public pricing page
    -- only because Feature.available is still false for them. Turning that flag on is the
    -- whole of the work needed to put them on sale.
    ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000003', 'api_access'),
    ('00000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-000000000003', 'ai_assistant'),
    ('00000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-000000000003', 'advanced_reports'),
    ('00000000-0000-4000-8000-000000000027', '00000000-0000-4000-8000-000000000003', 'automation'),
    ('00000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000004', 'api_access'),
    ('00000000-0000-4000-8000-000000000029', '00000000-0000-4000-8000-000000000004', 'ai_assistant'),
    ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000004', 'advanced_reports'),
    ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000004', 'automation'),
    ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000004', 'advanced_inventory'),
    ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000004', 'managed_backups'),
    ('00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000004', 'managed_whatsapp'),
    ('00000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-000000000004', 'sso'),
    ('00000000-0000-4000-8000-000000000038', '00000000-0000-4000-8000-000000000004', 'audit_export'),
    ('00000000-0000-4000-8000-000000000039', '00000000-0000-4000-8000-000000000004', 'custom_limits'),
    ('00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000004', 'dedicated_support')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Limits
--
-- `source` is the important column and it is not decoration:
--   COUNTED  is read from live rows at the moment of the check (users, branches,
--            products). Nothing is stored, so the number a business is shown cannot
--            drift away from the number of records that actually exist.
--   METERED  is an accumulated counter in UsageRecord (transactions, AI, API, storage).
--
-- -1 is UNLIMITED, deliberately not a very large number: a plan set to a billion should
-- not behave differently from a plan set to unlimited after one more sale.
--
-- Community's numbers are set so a single location shop can run the business properly
-- for years. It is a working business system, not a trial that expires mid quarter.
-- ============================================================================

INSERT INTO "PlanLimit" ("id", "planId", "key", "value", "source", "unit", "period") VALUES
    -- Community: one shop, one location, a small team.
    ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'users',                3,   'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'branches',             1,   'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', 'products',             200, 'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000001', 'monthly_transactions', 1000,'METERED', 'per_month', 'monthly'),
    ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000001', 'storage_megabytes',    1024,'METERED', 'megabytes', 'never'),

    -- Starter: a second location and a slightly bigger team.
    ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000002', 'users',                5,   'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000002', 'branches',             3,   'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000002', 'products',             1000,'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000002', 'monthly_transactions', 10000,'METERED','per_month', 'monthly'),
    ('00000000-0000-4000-8000-000000000115', '00000000-0000-4000-8000-000000000002', 'storage_megabytes',    5120,'METERED', 'megabytes', 'never'),
    ('00000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-000000000002', 'ai_requests',          500, 'METERED', 'per_month', 'monthly'),
    ('00000000-0000-4000-8000-000000000117', '00000000-0000-4000-8000-000000000002', 'api_requests',         2000,'METERED', 'per_month', 'monthly'),

    -- Business: several locations, a real team.
    ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000003', 'users',                25,  'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-000000000003', 'branches',             15,  'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000123', '00000000-0000-4000-8000-000000000003', 'products',             20000,'COUNTED','count',     'never'),
    ('00000000-0000-4000-8000-000000000124', '00000000-0000-4000-8000-000000000003', 'monthly_transactions', 100000,'METERED','per_month','monthly'),
    ('00000000-0000-4000-8000-000000000125', '00000000-0000-4000-8000-000000000003', 'storage_megabytes',    102400,'METERED','megabytes','never'),
    ('00000000-0000-4000-8000-000000000126', '00000000-0000-4000-8000-000000000003', 'ai_requests',          10000,'METERED','per_month','monthly'),
    ('00000000-0000-4000-8000-000000000127', '00000000-0000-4000-8000-000000000003', 'api_requests',         25000,'METERED','per_month','monthly'),

    -- Enterprise: negotiated rather than guessed. The seeded numbers are the floor an
    -- administrator can raise with an EntitlementOverride or edit here; they are not a
    -- promise that Enterprise is capped, which is why nothing is set to -1 by accident.
    ('00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000004', 'users',                -1,  'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000132', '00000000-0000-4000-8000-000000000004', 'branches',             -1,  'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000133', '00000000-0000-4000-8000-000000000004', 'products',             -1,  'COUNTED', 'count',     'never'),
    ('00000000-0000-4000-8000-000000000134', '00000000-0000-4000-8000-000000000004', 'monthly_transactions', -1,  'METERED', 'per_month', 'monthly'),
    ('00000000-0000-4000-8000-000000000135', '00000000-0000-4000-8000-000000000004', 'storage_megabytes',    -1,  'METERED', 'megabytes', 'never'),
    ('00000000-0000-4000-8000-000000000136', '00000000-0000-4000-8000-000000000004', 'ai_requests',          -1,  'METERED', 'per_month', 'monthly'),
    ('00000000-0000-4000-8000-000000000137', '00000000-0000-4000-8000-000000000004', 'api_requests',         -1,  'METERED', 'per_month', 'monthly')
ON CONFLICT ("planId", "key") DO NOTHING;

-- ============================================================================
-- 3. Subscription: widen the stub, then backfill it
--
-- `billingCycle` becomes `billingInterval` and nothing is read from it, so the rename is
-- safe. `planId` becomes a real foreign key, which is only possible after the backfill
-- below: the old column held free text from an older experiment, and pointing a
-- constraint at values that do not identify a plan would fail.
-- ============================================================================

ALTER TABLE "Subscription" ADD COLUMN "planPriceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodStart" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "graceEndsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "canceledAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "providerCustomerId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "providerSubscriptionCode" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodBrand" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodLast4" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodExpiry" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Subscription" ADD COLUMN "pendingPlanId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "pendingPlanChangeAt" TIMESTAMP(3);

ALTER TABLE "Subscription" RENAME COLUMN "billingCycle" TO "billingInterval";

-- Community, which is free forever. A stub row that said TRIALING would leave an
-- existing business looking like it was on a trial that had been running since the day
-- the feature was half built.
UPDATE "Subscription" SET "status" = 'ACTIVE';

-- Any pre-existing subscription, and any organization whose planId was a leftover string
-- or NULL, now sits on Community. That is exactly what it already had in practice: the
-- stub recorded a plan but nothing ever granted anything from it.
UPDATE "Subscription" SET "planId" = '00000000-0000-4000-8000-000000000001';
UPDATE "Organization" SET "planId" = '00000000-0000-4000-8000-000000000001';

ALTER TABLE "Subscription" ALTER COLUMN "planId" SET NOT NULL;

-- Every organization gets a subscription row, so there is no state in which a business
-- exists without one. The service also creates these on demand; this only means the
-- first request after deploying does not have to.
INSERT INTO "Subscription" ("id", "organizationId", "planId", "status", "billingInterval", "updatedAt")
SELECT gen_random_uuid()::text, o."id", '00000000-0000-4000-8000-000000000001', 'ACTIVE', 'monthly', CURRENT_TIMESTAMP
FROM "Organization" o
WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."organizationId" = o."id")
ON CONFLICT ("organizationId") DO NOTHING;

-- ============================================================================
-- 4. The remaining subscription tables
-- ============================================================================

CREATE TABLE "SubscriptionEvent" (
    "id"             TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "type"           TEXT NOT NULL,
    "fromStatus"     TEXT,
    "toStatus"       TEXT,
    "fromPlanId"     TEXT,
    "toPlanId"       TEXT,
    "reason"         TEXT,
    "metadata"       JSONB,
    "actorUserId"    TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionPayment" (
    "id"              TEXT NOT NULL,
    "subscriptionId"  TEXT NOT NULL,
    "organizationId"  TEXT NOT NULL,
    "planId"          TEXT NOT NULL,
    "reference"       TEXT NOT NULL,
    "idempotencyKey"  TEXT,
    "amountCents"     INTEGER NOT NULL,
    "currency"        TEXT NOT NULL,
    "kind"            TEXT NOT NULL DEFAULT 'INITIAL',
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "billingInterval" TEXT NOT NULL DEFAULT 'monthly',
    "provider"        TEXT NOT NULL DEFAULT 'PAYSTACK',
    "providerRef"     TEXT,
    "authorizationUrl" TEXT,
    "periodStart"     TIMESTAMP(3),
    "periodEnd"       TIMESTAMP(3),
    "paidAt"          TIMESTAMP(3),
    "failureReason"   TEXT,
    "refundedAt"      TIMESTAMP(3),
    "refundReason"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- The reference is the provider's handle for this charge and the idempotency key is the
-- caller's intent. Both are unique because both are what stops a double tap or a
-- replayed webhook from becoming two charges.
CREATE UNIQUE INDEX "SubscriptionPayment_reference_key" ON "SubscriptionPayment"("reference");
CREATE UNIQUE INDEX "SubscriptionPayment_idempotencyKey_key" ON "SubscriptionPayment"("idempotencyKey");
CREATE INDEX "SubscriptionPayment_organizationId_createdAt_idx" ON "SubscriptionPayment"("organizationId", "createdAt");
CREATE INDEX "SubscriptionPayment_subscriptionId_status_idx" ON "SubscriptionPayment"("subscriptionId", "status");
CREATE INDEX "SubscriptionPayment_status_createdAt_idx" ON "SubscriptionPayment"("status", "createdAt");

CREATE TABLE "UsageRecord" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key"            TEXT NOT NULL,
    "quantity"       INTEGER NOT NULL DEFAULT 0,
    "periodStart"    TIMESTAMP(3) NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- One counter per key per period. The unique index is what lets usage be recorded with a
-- single atomic upsert rather than a read followed by a write, which is how two tills
-- taking a sale at the same moment would otherwise lose one of the counts.
CREATE UNIQUE INDEX "UsageRecord_organizationId_key_periodStart_key"
    ON "UsageRecord"("organizationId", "key", "periodStart");
CREATE INDEX "UsageRecord_organizationId_key_idx" ON "UsageRecord"("organizationId", "key");

CREATE TABLE "EntitlementOverride" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "featureKey"     TEXT,
    "limitKey"       TEXT,
    "kind"           TEXT NOT NULL,
    "value"          JSONB,
    "reason"         TEXT NOT NULL,
    "expiresAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntitlementOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EntitlementOverride_organizationId_idx" ON "EntitlementOverride"("organizationId");

CREATE TABLE "PlatformAdmin" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "scopes"    TEXT[] NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdmin_userId_key" ON "PlatformAdmin"("userId");
CREATE INDEX "PlatformAdmin_status_idx" ON "PlatformAdmin"("status");

-- ============================================================================
-- 5. Indexes and foreign keys
--
-- Every constraint below is added after the data is in place, and the delete behaviour is
-- chosen per relation rather than by habit:
--   Cascade  where the child has no meaning without the parent (a subscription's events).
--   Restrict (the default) everywhere else, so a plan in use cannot be deleted out from
--            under a paying customer. That is the failure this schema is here to prevent.
-- ============================================================================

CREATE INDEX "SubscriptionEvent_subscriptionId_createdAt_idx" ON "SubscriptionEvent"("subscriptionId", "createdAt");
CREATE INDEX "SubscriptionEvent_type_idx" ON "SubscriptionEvent"("type");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "Feature"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanLimit" ADD CONSTRAINT "PlanLimit_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planPriceId_fkey" FOREIGN KEY ("planPriceId") REFERENCES "PlanPrice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatformAdmin" ADD CONSTRAINT "PlatformAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;