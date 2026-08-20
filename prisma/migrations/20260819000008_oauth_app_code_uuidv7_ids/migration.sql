-- Phase 3 chunk 2 of issue #734 (docs/adr/005). Hand-authored rather than
-- generated. Please verify against a real migration diff/CI before merging.

ALTER TABLE "oauth_apps" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "oauth_codes" ALTER COLUMN "id" DROP DEFAULT;
