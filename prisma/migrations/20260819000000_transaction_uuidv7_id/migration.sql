-- Phase 2 of issue #734 (docs/adr/005): move the id default off the database
-- and into application code (uuidv7(), src/utils/uuidv7.ts). Existing rows
-- keep their CUID values unchanged; only newly inserted rows get UUIDv7 ids.
--
-- NOTE: hand-authored rather than generated. Please verify against a real
-- migration diff/CI before merging.

ALTER TABLE "_transactions" ALTER COLUMN "id" DROP DEFAULT;
