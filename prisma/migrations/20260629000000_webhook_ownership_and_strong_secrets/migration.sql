-- Issue #478: Associate subscriptions with an API key owner
ALTER TABLE "WebhookSubscription" ADD COLUMN "apiKeyId" TEXT NOT NULL DEFAULT '';

-- Issue #481: Secret is now always present (non-null); backfill empty strings so
-- existing rows satisfy the NOT NULL constraint before the default is dropped.
ALTER TABLE "WebhookSubscription" ALTER COLUMN "secret" SET NOT NULL;
UPDATE "WebhookSubscription" SET "secret" = '' WHERE "secret" IS NULL;

-- Index for owner-scoped queries
CREATE INDEX "WebhookSubscription_apiKeyId_idx" ON "WebhookSubscription"("apiKeyId");
