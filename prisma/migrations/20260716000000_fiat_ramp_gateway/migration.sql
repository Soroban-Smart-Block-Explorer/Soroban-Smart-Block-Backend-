-- ============================================================================
-- Migration: 20260716000000_fiat_ramp_gateway
--
-- Adds all tables required by the multi-provider fiat on/off-ramp gateway:
--   RampKycRecord      – universal KYC verification state per user
--   RampOrder          – full order lifecycle tracking
--   RampOrderEvent     – immutable audit log of every order state transition
--   RampReconciliation – daily provider reconciliation runs
--   RampAmlFlag        – AML monitoring alerts
-- ============================================================================

-- KYC records (one per user, shared across providers after consent)
CREATE TABLE "ramp_kyc_records" (
  "id"                  TEXT        NOT NULL,
  "userId"              TEXT        NOT NULL,
  "tier"                TEXT        NOT NULL DEFAULT 'tier1',
  "status"              TEXT        NOT NULL DEFAULT 'pending',
  "documentType"        TEXT,
  "documentCountry"     TEXT,
  "livenessScore"       DOUBLE PRECISION,
  "pepScreened"         BOOLEAN     NOT NULL DEFAULT false,
  "sanctionsScreened"   BOOLEAN     NOT NULL DEFAULT false,
  "verifiedAt"          TIMESTAMP(3),
  "expiresAt"           TIMESTAMP(3),
  "providerKycIds"      JSONB       NOT NULL DEFAULT '{}',
  "dailyLimitUsd"       DOUBLE PRECISION NOT NULL DEFAULT 1000,
  "monthlyLimitUsd"     DOUBLE PRECISION NOT NULL DEFAULT 10000,
  "dailyUsedUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "monthlyUsedUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "usageResetAt"        TIMESTAMP(3),
  "jurisdiction"        TEXT,
  "blocked"             BOOLEAN     NOT NULL DEFAULT false,
  "blockReason"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ramp_kyc_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ramp_kyc_records_userId_key" ON "ramp_kyc_records"("userId");
CREATE INDEX "ramp_kyc_records_status_idx" ON "ramp_kyc_records"("status");
CREATE INDEX "ramp_kyc_records_tier_idx" ON "ramp_kyc_records"("tier");
CREATE INDEX "ramp_kyc_records_jurisdiction_idx" ON "ramp_kyc_records"("jurisdiction");

-- Ramp orders
CREATE TABLE "ramp_orders" (
  "id"                TEXT        NOT NULL,
  "userId"            TEXT        NOT NULL,
  "kycId"             TEXT,
  "direction"         TEXT        NOT NULL,  -- 'buy' | 'sell'
  "provider"          TEXT        NOT NULL,
  "providerOrderId"   TEXT,
  "status"            TEXT        NOT NULL DEFAULT 'pending',
  "fiatAmount"        DOUBLE PRECISION NOT NULL,
  "fiatCurrency"      TEXT        NOT NULL DEFAULT 'USD',
  "cryptoAmount"      DOUBLE PRECISION,
  "cryptoAsset"       TEXT        NOT NULL,
  "walletAddress"     TEXT        NOT NULL,
  "paymentMethod"     TEXT        NOT NULL,
  "exchangeRate"      DOUBLE PRECISION,
  "platformFeeUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "providerFeeUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "networkFeeUsd"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalCostUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txHash"            TEXT,
  "refundAmount"      DOUBLE PRECISION,
  "refundStatus"      TEXT,
  "refundedAt"        TIMESTAMP(3),
  "userIp"            TEXT,
  "userCountry"       TEXT,
  "metadata"          JSONB       NOT NULL DEFAULT '{}',
  "completedAt"       TIMESTAMP(3),
  "failedAt"          TIMESTAMP(3),
  "failureReason"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ramp_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ramp_orders_userId_idx" ON "ramp_orders"("userId");
CREATE INDEX "ramp_orders_status_idx" ON "ramp_orders"("status");
CREATE INDEX "ramp_orders_provider_idx" ON "ramp_orders"("provider");
CREATE INDEX "ramp_orders_providerOrderId_idx" ON "ramp_orders"("providerOrderId");
CREATE INDEX "ramp_orders_direction_idx" ON "ramp_orders"("direction");
CREATE INDEX "ramp_orders_createdAt_idx" ON "ramp_orders"("createdAt" DESC);
CREATE INDEX "ramp_orders_userId_status_idx" ON "ramp_orders"("userId", "status");

-- Immutable audit log for order state transitions
CREATE TABLE "ramp_order_events" (
  "id"          TEXT        NOT NULL,
  "orderId"     TEXT        NOT NULL,
  "fromStatus"  TEXT,
  "toStatus"    TEXT        NOT NULL,
  "triggeredBy" TEXT        NOT NULL DEFAULT 'system',
  "payload"     JSONB       NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ramp_order_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ramp_order_events_orderId_idx" ON "ramp_order_events"("orderId");
CREATE INDEX "ramp_order_events_createdAt_idx" ON "ramp_order_events"("createdAt");

-- Daily reconciliation runs
CREATE TABLE "ramp_reconciliations" (
  "id"                TEXT        NOT NULL,
  "provider"          TEXT        NOT NULL,
  "periodDate"        TEXT        NOT NULL,  -- YYYY-MM-DD
  "status"            TEXT        NOT NULL DEFAULT 'pending',
  "ordersChecked"     INT         NOT NULL DEFAULT 0,
  "discrepancyCount"  INT         NOT NULL DEFAULT 0,
  "discrepancies"     JSONB       NOT NULL DEFAULT '[]',
  "totalVolumeUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "errorRate"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  "runAt"             TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ramp_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ramp_reconciliations_provider_period_key" ON "ramp_reconciliations"("provider", "periodDate");
CREATE INDEX "ramp_reconciliations_status_idx" ON "ramp_reconciliations"("status");
CREATE INDEX "ramp_reconciliations_provider_idx" ON "ramp_reconciliations"("provider");

-- AML monitoring flags
CREATE TABLE "ramp_aml_flags" (
  "id"          TEXT        NOT NULL,
  "userId"      TEXT        NOT NULL,
  "orderId"     TEXT,
  "flagType"    TEXT        NOT NULL,
  "severity"    TEXT        NOT NULL DEFAULT 'medium',
  "description" TEXT        NOT NULL,
  "metadata"    JSONB       NOT NULL DEFAULT '{}',
  "resolved"    BOOLEAN     NOT NULL DEFAULT false,
  "resolvedBy"  TEXT,
  "resolvedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ramp_aml_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ramp_aml_flags_userId_idx" ON "ramp_aml_flags"("userId");
CREATE INDEX "ramp_aml_flags_orderId_idx" ON "ramp_aml_flags"("orderId");
CREATE INDEX "ramp_aml_flags_flagType_idx" ON "ramp_aml_flags"("flagType");
CREATE INDEX "ramp_aml_flags_resolved_idx" ON "ramp_aml_flags"("resolved");
CREATE INDEX "ramp_aml_flags_createdAt_idx" ON "ramp_aml_flags"("createdAt" DESC);
