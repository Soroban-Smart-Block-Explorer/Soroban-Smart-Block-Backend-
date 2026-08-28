-- Migration: 20260828000000_catch_up_checkpoints
-- Issue #881: Add per-batch checkpointing for catch-up workers with DB persistence
--
-- Each row records one [rangeStart, rangeEnd] chunk processed by a parallel
-- catch-up worker. On crash-restart the indexer resumes from lastCommittedLedger
-- rather than re-fetching from rangeStart, eliminating redundant RPC calls and
-- the risk of partial-batch duplicate processing.

CREATE TABLE IF NOT EXISTS "_catch_up_checkpoints" (
    "id"                     TEXT         NOT NULL PRIMARY KEY,
    "range_start"            INTEGER      NOT NULL,
    "range_end"              INTEGER      NOT NULL,
    "last_committed_ledger"  INTEGER,
    "completed"              BOOLEAN      NOT NULL DEFAULT false,
    "updated_at"             TIMESTAMP(3) NOT NULL,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Composite unique key prevents duplicate rows when two workers race on the
-- same chunk and both try to upsert simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS "_catch_up_checkpoints_range_start_range_end_key"
    ON "_catch_up_checkpoints"("range_start", "range_end");

-- Partial index for quickly finding incomplete chunks on restart.
CREATE INDEX IF NOT EXISTS "_catch_up_checkpoints_completed_idx"
    ON "_catch_up_checkpoints"("completed");
