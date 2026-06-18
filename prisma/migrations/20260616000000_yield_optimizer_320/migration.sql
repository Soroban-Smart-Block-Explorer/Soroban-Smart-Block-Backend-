-- #320: Yield Farming & Staking Optimizer
-- Creates tables for detecting yield opportunities, tracking historical APY,
-- and caching per-opportunity risk scores and TVL snapshots.

CREATE TABLE IF NOT EXISTS "YieldOpportunity" (
  "id"              TEXT        NOT NULL,
  "contractAddress" TEXT        NOT NULL,
  "name"            TEXT        NOT NULL,
  "type"            TEXT        NOT NULL,
  "tokens"          JSONB       NOT NULL DEFAULT '[]',
  "baseApy"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "incentiveApy"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalApy"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "tvl"             TEXT        NOT NULL DEFAULT '0',
  "lockupDays"      INTEGER     NOT NULL DEFAULT 0,
  "minDeposit"      TEXT        NOT NULL DEFAULT '0',
  "depositFee"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "withdrawFee"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "riskScore"       INTEGER     NOT NULL DEFAULT 0,
  "riskLabel"       TEXT        NOT NULL DEFAULT 'unknown',
  "lastObservedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "YieldOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "YieldOpportunity_contractAddress_type_key"
  ON "YieldOpportunity" ("contractAddress", "type");

CREATE INDEX IF NOT EXISTS "YieldOpportunity_type_idx"
  ON "YieldOpportunity" ("type");

CREATE INDEX IF NOT EXISTS "YieldOpportunity_totalApy_idx"
  ON "YieldOpportunity" ("totalApy" DESC);

CREATE INDEX IF NOT EXISTS "YieldOpportunity_riskScore_idx"
  ON "YieldOpportunity" ("riskScore");

CREATE INDEX IF NOT EXISTS "YieldOpportunity_lastObservedAt_idx"
  ON "YieldOpportunity" ("lastObservedAt");

CREATE TABLE IF NOT EXISTS "YieldHistorySnapshot" (
  "id"              TEXT        NOT NULL,
  "opportunityId"   TEXT        NOT NULL,
  "snapshotDate"    TIMESTAMP(3) NOT NULL,
  "apy"             DOUBLE PRECISION NOT NULL,
  "baseApy"         DOUBLE PRECISION NOT NULL,
  "incentiveApy"    DOUBLE PRECISION NOT NULL,
  "tvl"             TEXT        NOT NULL,
  "ledgerSequence"  INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "YieldHistorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "YieldHistorySnapshot_opportunityId_snapshotDate_key"
  ON "YieldHistorySnapshot" ("opportunityId", "snapshotDate");

CREATE INDEX IF NOT EXISTS "YieldHistorySnapshot_opportunityId_idx"
  ON "YieldHistorySnapshot" ("opportunityId");

CREATE INDEX IF NOT EXISTS "YieldHistorySnapshot_snapshotDate_idx"
  ON "YieldHistorySnapshot" ("snapshotDate" DESC);
