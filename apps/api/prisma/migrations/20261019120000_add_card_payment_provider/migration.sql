-- Which payment rail opened a pending payment attempt. Existing rows are all
-- Paystack card attempts (M-PESA did not exist at POS when this table was
-- created), so the default states the truth about every current row.
ALTER TABLE "CardPayment" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PAYSTACK';
