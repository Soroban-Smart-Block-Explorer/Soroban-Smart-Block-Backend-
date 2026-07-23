-- Extend AuditSubscription with delivery channel fields
ALTER TABLE "AuditSubscription"
  ADD COLUMN IF NOT EXISTS "emailAddress"    TEXT,
  ADD COLUMN IF NOT EXISTS "webhookUrl"      TEXT,
  ADD COLUMN IF NOT EXISTS "webhookSecret"   TEXT,
  ADD COLUMN IF NOT EXISTS "slackWebhookUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "slackChannel"    TEXT,
  ADD COLUMN IF NOT EXISTS "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "lastTriggeredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Audit notification delivery log
CREATE TABLE "AuditNotificationDelivery" (
  "id"             TEXT        NOT NULL PRIMARY KEY,
  "subscriptionId" TEXT        NOT NULL,
  "alertType"      TEXT        NOT NULL,
  "channel"        TEXT        NOT NULL,
  "status"         TEXT        NOT NULL DEFAULT 'pending',
  "payload"        JSONB       NOT NULL DEFAULT '{}',
  "httpStatus"     INTEGER,
  "responseBody"   TEXT,
  "errorMsg"       TEXT,
  "attempt"        INTEGER     NOT NULL DEFAULT 1,
  "deliveredAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("subscriptionId") REFERENCES "AuditSubscription"("id") ON DELETE CASCADE
);

CREATE INDEX "AuditNotificationDelivery_subscriptionId_idx"
  ON "AuditNotificationDelivery"("subscriptionId");
CREATE INDEX "AuditNotificationDelivery_status_idx"
  ON "AuditNotificationDelivery"("status");
CREATE INDEX "AuditNotificationDelivery_createdAt_idx"
  ON "AuditNotificationDelivery"("createdAt" DESC);
