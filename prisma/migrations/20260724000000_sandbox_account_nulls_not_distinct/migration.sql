-- Fix issue #606: SandboxAccount unique constraint allows duplicate null publicKeys on PG < 15
--
-- Root cause: @@unique([sessionId, publicKey]) where publicKey is String? creates a standard
-- B-tree unique index.  PostgreSQL 14 and earlier treat each NULL as distinct, so two rows
-- with (sessionId='X', publicKey=NULL) would silently coexist — violating the intent of the
-- constraint.  PostgreSQL 15 introduced NULLS NOT DISTINCT for unique indexes; PostgreSQL 16
-- (this project's stated minimum per CONTRIBUTING.md) fully supports it.
--
-- Fix: drop the auto-generated unique index and recreate it as UNIQUE NULLS NOT DISTINCT so
-- that (sessionId, NULL) and (sessionId, NULL) correctly collide and raise a constraint error.
--
-- Prisma DSL note: Prisma 5.x does not expose NULLS NOT DISTINCT in its schema language, so
-- the @@unique([sessionId, publicKey]) directive is kept in schema.prisma solely to preserve
-- the generated `sessionId_publicKey` compound-key helper (used in fundAccount's `where`
-- clause).  This raw migration overrides the underlying index on the real database.
--
-- Data migration: every write path in src/sandbox/runtime.ts calls makePublicKey() which
-- always returns a non-null G-address, so no existing row should have publicKey = NULL in
-- production.  No backfill is required.  If any NULL rows are somehow present they will block
-- the CREATE UNIQUE INDEX step and must be cleaned up first (see note below).

-- Step 1: drop the Prisma-generated unique index by its conventional name.
-- (Prisma names compound unique indexes as "<Table>_<col1>_<col2>_key".)
DROP INDEX IF EXISTS "SandboxAccount_sessionId_publicKey_key";

-- Step 2: recreate as UNIQUE NULLS NOT DISTINCT.
-- NULLS NOT DISTINCT means two rows with the same sessionId and publicKey = NULL are treated
-- as duplicates and the second insert/upsert raises a unique_violation (PG error 23505).
CREATE UNIQUE INDEX "SandboxAccount_sessionId_publicKey_key"
    ON "SandboxAccount" ("sessionId", "publicKey") NULLS NOT DISTINCT;

-- Note for operators: if this migration fails with
--   ERROR: could not create unique index "SandboxAccount_sessionId_publicKey_key"
--   DETAIL: Key (sessionId, publicKey)=(...) is duplicated.
-- run the following query to inspect colliding rows, then remove duplicates before re-running:
--
--   SELECT "sessionId", "publicKey", COUNT(*) AS n
--   FROM   "SandboxAccount"
--   WHERE  "publicKey" IS NULL
--   GROUP BY "sessionId", "publicKey"
--   HAVING COUNT(*) > 1;
