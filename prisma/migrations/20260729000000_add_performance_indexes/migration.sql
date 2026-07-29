-- Add missing indexes for common query patterns identified by index audit (issue #723)

-- Transaction: time-range queries (e.g. backfills, dashboards)
CREATE INDEX IF NOT EXISTS "Transaction_ledgerCloseTime_idx" ON "Transaction"("ledgerCloseTime");

-- Event: cursor pagination and recency queries
CREATE INDEX IF NOT EXISTS "Event_ledgerSequence_id_idx" ON "Event"("ledgerSequence", "id");
CREATE INDEX IF NOT EXISTS "Event_createdAt_idx" ON "Event"("createdAt");

-- Contract: recently deployed listing
CREATE INDEX IF NOT EXISTS "Contract_createdAt_idx" ON "Contract"("createdAt");

-- StellarAccount: active-accounts queries
CREATE INDEX IF NOT EXISTS "StellarAccount_lastActivity_idx" ON "StellarAccount"("lastActivity");

-- PauseEvent: per-contract timeline queries
CREATE INDEX IF NOT EXISTS "PauseEvent_contractAddress_timestamp_idx" ON "PauseEvent"("contractAddress", "timestamp");

-- AlertConfiguration: active-alerts-by-type lookups
CREATE INDEX IF NOT EXISTS "AlertConfiguration_alertType_isActive_idx" ON "AlertConfiguration"("alertType", "isActive");
