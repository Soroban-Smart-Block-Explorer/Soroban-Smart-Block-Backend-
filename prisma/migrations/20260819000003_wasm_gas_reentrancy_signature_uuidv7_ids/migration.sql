-- Phase 3 chunk 1 of issue #734 (docs/adr/005): move the id default off the
-- database and into application code (uuidv7(), src/utils/uuidv7.ts) for the
-- next batch of cuid()-shaped models. Existing rows keep their CUID values
-- unchanged; only newly inserted rows get UUIDv7 ids.
--
-- NOTE: hand-authored rather than generated. Please verify against a real
-- migration diff/CI before merging.

ALTER TABLE "_wasm_upgrade_histories" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "_gas_analytics_snapshots" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "_reentrancy_alerts" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "_signature_inspections" ALTER COLUMN "id" DROP DEFAULT;
