-- #220: High-Throughput Batch-Settlement Event Compact Engine
-- 1. Add `compacted` flag to Event for tracking which rows have been rolled up.
-- 2. Create SettlementBatchSummary table for compact master summaries.

ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "compacted" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS "Event_eventType_compacted_ledgerSequence_idx"
  ON "Event" ("eventType", "compacted", "ledgerSequence");

CREATE TABLE IF NOT EXISTS "SettlementBatchSummary" (
  "id"              TEXT        NOT NULL,
  "contractAddress" TEXT        NOT NULL,
  "windowKey"       INTEGER     NOT NULL,
  "ledgerMin"       INTEGER     NOT NULL,
  "ledgerMax"       INTEGER     NOT NULL,
  "windowStart"     TIMESTAMP(3) NOT NULL,
  "windowEnd"       TIMESTAMP(3) NOT NULL,
  "eventCount"      INTEGER     NOT NULL,
  "totalAmount"     TEXT        NOT NULL,
  "uniqueParties"   INTEGER     NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SettlementBatchSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SettlementBatchSummary_contractAddress_windowKey_key"
  ON "SettlementBatchSummary" ("contractAddress", "windowKey");

CREATE INDEX IF NOT EXISTS "SettlementBatchSummary_contractAddress_idx"
  ON "SettlementBatchSummary" ("contractAddress");

CREATE INDEX IF NOT EXISTS "SettlementBatchSummary_ledgerMin_idx"
  ON "SettlementBatchSummary" ("ledgerMin");

CREATE INDEX IF NOT EXISTS "SettlementBatchSummary_windowKey_idx"
  ON "SettlementBatchSummary" ("windowKey");
