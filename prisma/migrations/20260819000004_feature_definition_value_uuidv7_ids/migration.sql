-- Phase 3 chunk 2 of issue #734 (docs/adr/005). Hand-authored rather than
-- generated. Please verify against a real migration diff/CI before merging.

ALTER TABLE "_feature_definitions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "_feature_values" ALTER COLUMN "id" DROP DEFAULT;
