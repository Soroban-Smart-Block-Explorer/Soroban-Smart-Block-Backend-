-- Add processingStatus and leaseExpiresAt to WebhookDelivery for atomic row claiming
ALTER TABLE "WebhookDelivery" ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE "WebhookDelivery" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Composite index to efficiently query due deliveries that are not already being processed
CREATE INDEX "WebhookDelivery_status_nextRetryAt_processingStatus_idx"
    ON "WebhookDelivery"("status", "nextRetryAt", "processingStatus");
