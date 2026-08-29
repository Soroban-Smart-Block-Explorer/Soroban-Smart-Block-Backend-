-- Migration: 20260828000001_hash_legacy_api_keys
-- Issue #882: Hash legacy ApiKey secrets (currently stored plaintext)
--
-- Strategy:
--   1. Add `key_hash` column (SHA-256 hex) to _api_keies.
--   2. Backfill: compute SHA-256 of every existing plaintext key using
--      PostgreSQL's pgcrypto encode(digest(key, 'sha256'), 'hex').
--   3. Create a unique index on `key_hash`.
--   4. Drop the plaintext `key` column.
--
-- The WebSocket auth path (websocketServer.ts) and any other consumers now
-- hash the incoming raw key with SHA-256 before querying `key_hash`, matching
-- the pattern already used by DevApiKey / apiKeyAuth.ts.

-- 1. Add key_hash column (nullable during backfill)
ALTER TABLE "_api_keies"
    ADD COLUMN IF NOT EXISTS "key_hash" TEXT;

-- 2. Backfill SHA-256 from the existing plaintext key.
--    pgcrypto must be available; the extension is enabled by default on
--    AWS RDS/Aurora PostgreSQL. If it is not available, execute:
--      CREATE EXTENSION IF NOT EXISTS pgcrypto;
--    before running this migration.
UPDATE "_api_keies"
SET "key_hash" = encode(digest("key", 'sha256'), 'hex')
WHERE "key_hash" IS NULL;

-- 3. Make key_hash NOT NULL now that backfill is complete.
ALTER TABLE "_api_keies"
    ALTER COLUMN "key_hash" SET NOT NULL;

-- 4. Unique index on the hash for O(1) lookups.
CREATE UNIQUE INDEX IF NOT EXISTS "_api_keies_key_hash_key"
    ON "_api_keies"("key_hash");

-- 5. Drop the plaintext key column so it can never leak from the database.
ALTER TABLE "_api_keies"
    DROP COLUMN IF EXISTS "key";
