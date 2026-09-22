-- KaziOS initial database setup
-- Creates the kazios database if it doesn't exist (already created by POSTGRES_DB in compose)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Ensure the database is accessible by the postgres user
GRANT ALL PRIVILEGES ON DATABASE kazios TO postgres;