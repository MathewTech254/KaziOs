-- Add optional credit limit per customer (Kenyan "deni" credit sales).
-- Nullable = no limit enforced. Additive only; existing rows get NULL.
ALTER TABLE "Customer" ADD COLUMN "creditLimit" DOUBLE PRECISION;
