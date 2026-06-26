-- Distributed Rate Limiting, API Key Auth, Audit Logging, Abuse Detection

-- ── Extend DevApiKey with tier + rate limit override + IP/endpoint lists ──────
ALTER TABLE "DevApiKey"
  ADD COLUMN IF NOT EXISTS "tier"              TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "rateLimitOverride" INTEGER,
  ADD COLUMN IF NOT EXISTS "allowedEndpoints"  JSONB,
  ADD COLUMN IF NOT EXISTS "revokedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "usageCount"        INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "DevApiKey_tier_idx"    ON "DevApiKey"("tier");
CREATE INDEX IF NOT EXISTS "DevApiKey_keyHash_idx" ON "DevApiKey"("keyHash");

-- ── API Audit Log (partitioned by month) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ApiAuditLog" (
    "id"                  TEXT NOT NULL,
    "apiKeyId"            TEXT,
    "keyName"             TEXT,
    "tier"                TEXT NOT NULL DEFAULT 'unauthenticated',
    "ip"                  TEXT NOT NULL,
    "method"              TEXT NOT NULL,
    "endpoint"            TEXT NOT NULL,
    "statusCode"          INTEGER NOT NULL,
    "responseTimeMs"      INTEGER NOT NULL DEFAULT 0,
    "rateLimitRemaining"  INTEGER,
    "rateLimitLimit"      INTEGER,
    "userAgent"           TEXT,
    "requestId"           TEXT,
    "region"              TEXT,
    "isRateLimited"       BOOLEAN NOT NULL DEFAULT false,
    "month"               TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiAuditLog_pkey" PRIMARY KEY ("id", "month")
) PARTITION BY LIST ("month");

-- Seed partitions for next 12 months
DO $$
DECLARE
  d DATE := DATE_TRUNC('month', NOW());
  i INT;
  partition_name TEXT;
  month_val TEXT;
BEGIN
  FOR i IN 0..11 LOOP
    month_val := TO_CHAR(d + (i || ' months')::INTERVAL, 'YYYY-MM');
    partition_name := 'ApiAuditLog_' || REPLACE(month_val, '-', '_');
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = LOWER(partition_name)
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF "ApiAuditLog" FOR VALUES IN (%L)',
        partition_name, month_val
      );
    END IF;
  END LOOP;
END$$;

CREATE INDEX IF NOT EXISTS "ApiAuditLog_apiKeyId_idx"  ON "ApiAuditLog"("apiKeyId");
CREATE INDEX IF NOT EXISTS "ApiAuditLog_ip_idx"        ON "ApiAuditLog"("ip");
CREATE INDEX IF NOT EXISTS "ApiAuditLog_createdAt_idx" ON "ApiAuditLog"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "ApiAuditLog_endpoint_idx"  ON "ApiAuditLog"("endpoint");
CREATE INDEX IF NOT EXISTS "ApiAuditLog_isRateLimited_idx" ON "ApiAuditLog"("isRateLimited");

-- ── Abuse Event log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AbuseEvent" (
    "id"          TEXT NOT NULL,
    "pattern"     TEXT NOT NULL,
    "ip"          TEXT,
    "apiKeyId"    TEXT,
    "endpoint"    TEXT,
    "score"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "action"      TEXT NOT NULL DEFAULT 'monitor',
    "blockedUntil" TIMESTAMP(3),
    "evidence"    JSONB,
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbuseEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AbuseEvent_ip_idx"        ON "AbuseEvent"("ip");
CREATE INDEX IF NOT EXISTS "AbuseEvent_apiKeyId_idx"  ON "AbuseEvent"("apiKeyId");
CREATE INDEX IF NOT EXISTS "AbuseEvent_pattern_idx"   ON "AbuseEvent"("pattern");
CREATE INDEX IF NOT EXISTS "AbuseEvent_createdAt_idx" ON "AbuseEvent"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AbuseEvent_blockedUntil_idx" ON "AbuseEvent"("blockedUntil");
