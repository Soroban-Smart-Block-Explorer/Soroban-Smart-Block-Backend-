-- Add security fields to WebhookDelivery
ALTER TABLE "WebhookDelivery" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Add security fields to WebhookSubscription
ALTER TABLE "WebhookSubscription" ADD COLUMN "storeResponseBody" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WebhookSubscription" ADD COLUMN "responseRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- Add security fields to DevWebhookDelivery
ALTER TABLE "DevWebhookDelivery" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Add security fields to DevWebhook
ALTER TABLE "DevWebhook" ADD COLUMN "storeResponseBody" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DevWebhook" ADD COLUMN "responseRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- Create indexes for expiration columns for efficient cleanup queries
CREATE INDEX "WebhookDelivery_expiresAt_idx" ON "WebhookDelivery"("expiresAt");
CREATE INDEX "DevWebhookDelivery_expiresAt_idx" ON "DevWebhookDelivery"("expiresAt");
