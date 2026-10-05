-- What a live smoke run leaves behind, and what it should have produced.
-- Run against the scratch database after node scripts/smoke-subscriptions.mjs has run.

-- The metered counter for sales must have been written by the sale that was rung up.
SELECT "organizationId", key, quantity, "periodStart" FROM "UsageRecord" ORDER BY "createdAt";

-- Every business created by the run, and what its subscription says.
SELECT o.name, s.status, s."currentPeriodEnd", p.key AS plan
FROM "Organization" o
LEFT JOIN "Subscription" s ON s."organizationId" = o.id
LEFT JOIN "Plan" p ON p.id = s."planId"
ORDER BY o."createdAt";

-- Branches and members, against the Community allowances of one and three.
SELECT o.name,
       (SELECT count(*) FROM "Branch" b WHERE b."organizationId" = o.id) AS branches,
       (SELECT count(*) FROM "User" u WHERE u."organizationId" = o.id) AS members
FROM "Organization" o;

-- The ledger. A business that was refused should still have its creation event, and
-- nothing should have been written for a request that was turned away.
SELECT type, "fromStatus", "toStatus", reason FROM "SubscriptionEvent" ORDER BY "createdAt";

-- Community must hold every CORE feature: that is the promise that the free plan is a
-- working business system and not a crippled demo.
SELECT count(*) AS community_core_features
FROM "PlanFeature" pf
JOIN "Feature" f ON f.key = pf."featureKey"
WHERE pf."planId" = '00000000-0000-4000-8000-000000000001' AND f.category = 'CORE';

-- Community must not hold any commercial capability.
SELECT count(*) AS community_commercial_features
FROM "PlanFeature" pf
JOIN "Feature" f ON f.key = pf."featureKey"
WHERE pf."planId" = '00000000-0000-4000-8000-000000000001' AND f.category <> 'CORE';

-- Starter is where multi_branch starts, and it must not appear on Community.
SELECT p.key AS plan, pf."featureKey" AS feature
FROM "PlanFeature" pf JOIN "Plan" p ON p.id = pf."planId"
WHERE pf."featureKey" = 'multi_branch' ORDER BY p."sortOrder";

-- Only features the code can actually enforce may be advertised.
SELECT key, name, available FROM "Feature" WHERE available ORDER BY "sortOrder";

-- Enterprise is quoted, so it must have no purchasable price.
SELECT p.key, count(pp.id) AS prices
FROM "Plan" p LEFT JOIN "PlanPrice" pp ON pp."planId" = p.id
GROUP BY p.id ORDER BY p."sortOrder";