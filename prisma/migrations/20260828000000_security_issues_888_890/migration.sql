-- Migration: 20260828000000_security_issues_888_890
-- Closes #888: API key rotation lifecycle
--   - Adds rotated_from_key_id to _dev_api_keies for audit-trail chaining
--   - Adds index on expires_at for efficient expiry-enforcement queries
--
-- Closes #890: Sensitive read audit trail
--   - Creates _sensitive_read_audits table; rows are never pruned

-- #888 — add rotated_from_key_id to DevApiKey
ALTER TABLE "_dev_api_keies"
  ADD COLUMN IF NOT EXISTS "rotated_from_key_id" TEXT;

-- Index so we can cheaply answer "what was this key rotated from?"
CREATE INDEX IF NOT EXISTS "_dev_api_keies_rotated_from_key_id_idx"
  ON "_dev_api_keies" ("rotated_from_key_id");

-- Index to make the hourly expiry scan efficient
CREATE INDEX IF NOT EXISTS "_dev_api_keies_expires_at_idx"
  ON "_dev_api_keies" ("expires_at");

-- #890 — sensitive read audit table
CREATE TABLE IF NOT EXISTS "_sensitive_read_audits" (
  "id"          TEXT        NOT NULL PRIMARY KEY,
  "actor"       TEXT        NOT NULL,
  "ip"          TEXT        NOT NULL,
  "endpoint"    TEXT        NOT NULL,
  "method"      TEXT        NOT NULL,
  "target"      TEXT        NOT NULL,
  "request_id"  TEXT,
  "user_agent"  TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "_sensitive_read_audits_actor_idx"
  ON "_sensitive_read_audits" ("actor");

CREATE INDEX IF NOT EXISTS "_sensitive_read_audits_endpoint_idx"
  ON "_sensitive_read_audits" ("endpoint");

CREATE INDEX IF NOT EXISTS "_sensitive_read_audits_target_idx"
  ON "_sensitive_read_audits" ("target");

CREATE INDEX IF NOT EXISTS "_sensitive_read_audits_created_at_idx"
  ON "_sensitive_read_audits" ("created_at" DESC);
