-- CreateEnum
CREATE TYPE "DeveloperRole" AS ENUM ('admin', 'user', 'read_only', 'restricted');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('active', 'revoked', 'expired', 'suspended');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('success', 'failed', 'retrying');

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requestsPerDay" INTEGER NOT NULL,
    "requestsPerMonth" INTEGER NOT NULL,
    "priceMonthly" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Developer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "githubId" TEXT,
    "walletAddress" TEXT,
    "planId" TEXT,
    "role" "DeveloperRole" NOT NULL DEFAULT 'user',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Developer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevApiKey" (
    "id" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "allowedIps" JSONB,
    "allowedDomains" JSONB,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "status" "KeyStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevWebhook" (
    "id" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "retryPolicy" JSONB,
    "headers" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastDeliveryStatus" "DeliveryStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevWebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlan_name_key" ON "BillingPlan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Developer_email_key" ON "Developer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Developer_githubId_key" ON "Developer"("githubId");

-- CreateIndex
CREATE INDEX "Developer_email_idx" ON "Developer"("email");

-- CreateIndex
CREATE INDEX "DevApiKey_developerId_idx" ON "DevApiKey"("developerId");

-- CreateIndex
CREATE INDEX "DevApiKey_keyPrefix_idx" ON "DevApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "DevApiKey_status_idx" ON "DevApiKey"("status");

-- CreateIndex
CREATE INDEX "DevWebhook_developerId_idx" ON "DevWebhook"("developerId");

-- CreateIndex
CREATE INDEX "DevWebhookDelivery_webhookId_idx" ON "DevWebhookDelivery"("webhookId");

-- CreateIndex
CREATE INDEX "DevWebhookDelivery_delivered_idx" ON "DevWebhookDelivery"("delivered");

-- CreateIndex
CREATE INDEX "UsageRecord_developerId_idx" ON "UsageRecord"("developerId");

-- CreateIndex
CREATE INDEX "UsageRecord_apiKeyId_idx" ON "UsageRecord"("apiKeyId");

-- CreateIndex
CREATE INDEX "UsageRecord_createdAt_idx" ON "UsageRecord"("createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_endpoint_idx" ON "UsageRecord"("endpoint");

-- AddForeignKey
ALTER TABLE "Developer" ADD CONSTRAINT "Developer_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevApiKey" ADD CONSTRAINT "DevApiKey_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "Developer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevWebhook" ADD CONSTRAINT "DevWebhook_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "Developer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevWebhookDelivery" ADD CONSTRAINT "DevWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "DevWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "Developer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "DevApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
