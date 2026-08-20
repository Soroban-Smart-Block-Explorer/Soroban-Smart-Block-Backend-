-- Phase 3 chunk 2 of issue #734 (docs/adr/005). Hand-authored rather than
-- generated. Please verify against a real migration diff/CI before merging.

ALTER TABLE "_smart_wallets" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "_auth_decompositions" ALTER COLUMN "id" DROP DEFAULT;
