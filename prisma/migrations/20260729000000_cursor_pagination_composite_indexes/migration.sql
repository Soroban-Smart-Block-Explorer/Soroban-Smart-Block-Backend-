-- Composite indexes for cursor-based pagination on cursor-sorted fields.
-- Event: [ledgerSequence, id] for paginating events in ledger order
-- Transaction: [ledgerCloseTime, id] for time-based transaction pagination
-- PauseEvent: [contractAddress, timestamp] for per-contract pause event pagination
-- TokenPriceHistory already has [tokenAddress, timestamp(sort: Desc)]; no change needed.

CREATE INDEX IF NOT EXISTS "Event_ledgerSequence_id_idx" ON "Event"("ledgerSequence", "id");

CREATE INDEX IF NOT EXISTS "Transaction_ledgerCloseTime_id_idx" ON "Transaction"("ledgerCloseTime", "id");

CREATE INDEX IF NOT EXISTS "PauseEvent_contractAddress_timestamp_idx" ON "PauseEvent"("contractAddress", "timestamp");
