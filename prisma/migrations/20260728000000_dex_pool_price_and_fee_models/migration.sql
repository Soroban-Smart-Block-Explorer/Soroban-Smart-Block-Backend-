-- Migration: 20260728000000_dex_pool_price_and_fee_models
-- Resolves #630 — adds fields to DexPool and creates the six models required
-- by the five gated features (privacy WS, composability WS, arbitrage WS,
-- arbitrage scanner, pool price monitor, fee aggregator).
--
-- This migration is strictly additive (new columns / new tables only).
-- All new DexPool columns have DEFAULT values so existing rows are unaffected.

-- ─── DexPool: add missing fields ─────────────────────────────────────────────

ALTER TABLE "DexPool"
  -- Change existing required columns to have defaults (so minimal upsert works)
  ALTER COLUMN "poolAddress" SET DEFAULT '',
  ALTER COLUMN "chain"       SET DEFAULT 'stellar',
  ALTER COLUMN "protocol"    SET DEFAULT '',
  ALTER COLUMN "feeBps"      SET DEFAULT 0,
  ALTER COLUMN "tokenA"      SET DEFAULT '',
  ALTER COLUMN "tokenASymbol" SET DEFAULT '',
  ALTER COLUMN "tokenADecimals" SET DEFAULT 7,
  ALTER COLUMN "reserveA"   SET DEFAULT 0,
  ALTER COLUMN "tokenB"      SET DEFAULT '',
  ALTER COLUMN "tokenBSymbol" SET DEFAULT '',
  ALTER COLUMN "tokenBDecimals" SET DEFAULT 7,
  ALTER COLUMN "reserveB"   SET DEFAULT 0,
  -- New columns
  ADD COLUMN IF NOT EXISTS "dexName"         TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "contractAddress" VARCHAR(56)  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "feeTier"         DECIMAL(10,6),
  ADD COLUMN IF NOT EXISTS "totalLiquidity"  DECIMAL(30,7),
  ADD COLUMN IF NOT EXISTS "isActive"        BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "volume24h"       DECIMAL(30,7);

-- Unique constraint on contractAddress (pools are uniquely identified by it).
-- We use a standard unique index (not partial) so Prisma's upsert where clause works.
CREATE UNIQUE INDEX IF NOT EXISTS "DexPool_contractAddress_key"
  ON "DexPool" ("contractAddress");

CREATE INDEX IF NOT EXISTS "DexPool_isActive_idx"
  ON "DexPool" ("isActive");

CREATE INDEX IF NOT EXISTS "DexPool_dexName_idx"
  ON "DexPool" ("dexName");

-- ─── PoolPrice ───────────────────────────────────────────────────────────────
-- Per-block spot price snapshot. Written every ~2.5 s by pool-price-monitor.

CREATE TABLE IF NOT EXISTS "PoolPrice" (
  "id"          BIGSERIAL    PRIMARY KEY,
  "poolId"      TEXT         NOT NULL,
  "blockNumber" BIGINT       NOT NULL,
  "timestamp"   TIMESTAMPTZ  NOT NULL,
  "reserveA"    DECIMAL(30,0) NOT NULL,
  "reserveB"    DECIMAL(30,0) NOT NULL,
  "spotPrice"   DOUBLE PRECISION NOT NULL,
  "twap1m"      DOUBLE PRECISION,
  "twap5m"      DOUBLE PRECISION,
  "twap1h"      DOUBLE PRECISION,

  CONSTRAINT "PoolPrice_poolId_fkey"
    FOREIGN KEY ("poolId") REFERENCES "DexPool" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PoolPrice_poolId_blockNumber_key"
  ON "PoolPrice" ("poolId", "blockNumber");

CREATE INDEX IF NOT EXISTS "PoolPrice_poolId_timestamp_idx"
  ON "PoolPrice" ("poolId", "timestamp");

CREATE INDEX IF NOT EXISTS "PoolPrice_timestamp_idx"
  ON "PoolPrice" ("timestamp");

-- ─── FeeEvent ────────────────────────────────────────────────────────────────
-- Individual fee emission detected on-chain and classified by fee-classifier.

CREATE TABLE IF NOT EXISTS "FeeEvent" (
  "id"              BIGSERIAL    PRIMARY KEY,
  "txHash"          VARCHAR(64)  NOT NULL,
  "contractAddress" VARCHAR(56)  NOT NULL,
  "feeType"         VARCHAR(40)  NOT NULL,
  "destination"     VARCHAR(40)  NOT NULL,
  "amount"          DECIMAL(30,7) NOT NULL,
  "token"           VARCHAR(56)  NOT NULL,
  "usdValue"        DOUBLE PRECISION,
  "sender"          VARCHAR(56),
  "receiver"        VARCHAR(56),
  "blockNumber"     BIGINT       NOT NULL,
  "timestamp"       TIMESTAMPTZ  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "FeeEvent_txHash_feeType_destination_key"
  ON "FeeEvent" ("txHash", "feeType", "destination");

CREATE INDEX IF NOT EXISTS "FeeEvent_contractAddress_timestamp_idx"
  ON "FeeEvent" ("contractAddress", "timestamp");

CREATE INDEX IF NOT EXISTS "FeeEvent_feeType_idx"
  ON "FeeEvent" ("feeType");

CREATE INDEX IF NOT EXISTS "FeeEvent_timestamp_idx"
  ON "FeeEvent" ("timestamp");

-- ─── ProtocolRevenue ─────────────────────────────────────────────────────────
-- Aggregated protocol revenue for a contract over a calendar bucket.

CREATE TABLE IF NOT EXISTS "ProtocolRevenue" (
  "id"              TEXT         PRIMARY KEY,
  "contractAddress" VARCHAR(56)  NOT NULL,
  "protocolName"    VARCHAR(120),
  "period"          VARCHAR(10)  NOT NULL,
  "timestamp"       TIMESTAMPTZ  NOT NULL,
  "totalFees"       DECIMAL(30,7) NOT NULL,
  "swapFees"        DECIMAL(30,7),
  "withdrawFees"    DECIMAL(30,7),
  "performanceFees" DECIMAL(30,7),
  "protocolFees"    DECIMAL(30,7),
  "liquidationFees" DECIMAL(30,7),
  "interestSpread"  DECIMAL(30,7),
  "flashLoanFees"   DECIMAL(30,7),
  "referralFees"    DECIMAL(30,7),
  "lpRewards"       DECIMAL(30,7),
  "treasuryAmount"  DECIMAL(30,7),
  "burnedAmount"    DECIMAL(30,7),
  "stakerRewards"   DECIMAL(30,7),
  "insuranceFund"   DECIMAL(30,7),
  "ecosystemFund"   DECIMAL(30,7),
  "teamVesting"     DECIMAL(30,7),
  "feeToken"        VARCHAR(56),
  "usdValue"        DOUBLE PRECISION,
  "txCount"         INTEGER,
  "uniqueUsers"     INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProtocolRevenue_contractAddress_period_timestamp_key"
  ON "ProtocolRevenue" ("contractAddress", "period", "timestamp");

CREATE INDEX IF NOT EXISTS "ProtocolRevenue_contractAddress_period_timestamp_idx"
  ON "ProtocolRevenue" ("contractAddress", "period", "timestamp");

CREATE INDEX IF NOT EXISTS "ProtocolRevenue_period_timestamp_idx"
  ON "ProtocolRevenue" ("period", "timestamp");

-- ─── YieldSnapshot ───────────────────────────────────────────────────────────
-- Point-in-time yield (APR) snapshot computed from rolling revenue windows.

CREATE TABLE IF NOT EXISTS "YieldSnapshot" (
  "id"               BIGSERIAL    PRIMARY KEY,
  "contractAddress"  VARCHAR(56)  NOT NULL,
  "protocolName"     VARCHAR(120),
  "timestamp"        TIMESTAMPTZ  NOT NULL,
  "lpApr1d"          DOUBLE PRECISION,
  "lpApr7d"          DOUBLE PRECISION,
  "lpApr30d"         DOUBLE PRECISION,
  "stakingApr1d"     DOUBLE PRECISION,
  "stakingApr7d"     DOUBLE PRECISION,
  "stakingApr30d"    DOUBLE PRECISION,
  "totalValueLocked" DECIMAL(30,7),
  "stakedValue"      DECIMAL(30,7),
  "revenueShare"     DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS "YieldSnapshot_contractAddress_timestamp_idx"
  ON "YieldSnapshot" ("contractAddress", "timestamp");

CREATE INDEX IF NOT EXISTS "YieldSnapshot_timestamp_idx"
  ON "YieldSnapshot" ("timestamp");

-- ─── ProtocolProfile ─────────────────────────────────────────────────────────
-- Lightweight registry mapping contract address → protocol name + TVL.

CREATE TABLE IF NOT EXISTS "ProtocolProfile" (
  "id"              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "contractAddress" VARCHAR(56)  NOT NULL UNIQUE,
  "protocolName"    VARCHAR(120) NOT NULL,
  "tvl"             DECIMAL(30,7),
  "createdAt"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ProtocolProfile_protocolName_idx"
  ON "ProtocolProfile" ("protocolName");

-- ─── RevenueAlert ────────────────────────────────────────────────────────────
-- Anomaly alerts raised when revenue spikes / drops exceed thresholds.

CREATE TABLE IF NOT EXISTS "RevenueAlert" (
  "id"              BIGSERIAL    PRIMARY KEY,
  "contractAddress" VARCHAR(56)  NOT NULL,
  "alertType"       VARCHAR(40)  NOT NULL,
  "severity"        VARCHAR(20)  NOT NULL,
  "message"         TEXT         NOT NULL,
  "metadata"        JSONB,
  "detectedAt"      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "RevenueAlert_contractAddress_detectedAt_idx"
  ON "RevenueAlert" ("contractAddress", "detectedAt");

CREATE INDEX IF NOT EXISTS "RevenueAlert_severity_idx"
  ON "RevenueAlert" ("severity");

CREATE INDEX IF NOT EXISTS "RevenueAlert_detectedAt_idx"
  ON "RevenueAlert" ("detectedAt");
