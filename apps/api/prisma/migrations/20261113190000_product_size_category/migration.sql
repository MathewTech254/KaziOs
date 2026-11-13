-- Product.size and Product.category are declared in schema.prisma and read and written
-- by the products route (create, update and the CSV import), but no migration ever
-- created them.
--
-- Prisma selects every scalar field on the model, so the missing columns made every
-- product query fail with P2022: the list, the detail and the unit endpoints all
-- answered 500 for every organization, which also blocked the production seeder.
--
-- IF NOT EXISTS keeps this safe to re-run, so applying it against a database that
-- already has the columns is a no-op rather than a failure.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "size" TEXT;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "category" TEXT;