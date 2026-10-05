-- Prices in KES.
--
-- KaziOS sells to Kenyan businesses in shillings, and Paystack charges whatever currency
-- the price row states. The yearly figures keep the same "two months free" shape the USD
-- numbers had (monthly x 10): Starter at KES 1,499/month or KES 14,990/year, Business at
-- KES 2,999/month or KES 29,990/year. Prices are rows, so an administrator can re-price
-- any of these without a deployment.

UPDATE "PlanPrice" SET "currency" = 'KES' WHERE "id" = '00000000-0000-4000-8000-000000000011';
UPDATE "PlanPrice" SET "amountCents" = 149900,  "currency" = 'KES' WHERE "id" = '00000000-0000-4000-8000-000000000012';
UPDATE "PlanPrice" SET "amountCents" = 1499000, "currency" = 'KES' WHERE "id" = '00000000-0000-4000-8000-000000000013';
UPDATE "PlanPrice" SET "amountCents" = 299900,  "currency" = 'KES' WHERE "id" = '00000000-0000-4000-8000-000000000014';
UPDATE "PlanPrice" SET "amountCents" = 2999000, "currency" = 'KES' WHERE "id" = '00000000-0000-4000-8000-000000000015';

-- The per-month quote shown beside a yearly price, same currency.
UPDATE "Plan" SET "yearlyPerMonthCents" = 1249 WHERE "key" = 'starter';
UPDATE "Plan" SET "yearlyPerMonthCents" = 2499 WHERE "key" = 'business';
