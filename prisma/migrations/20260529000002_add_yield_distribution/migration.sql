-- Migration: add_yield_distribution
-- Adds YieldDistribution model for RWA treasury batch payout tracking

CREATE TABLE "YieldDistribution" (
    "id"              TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "distributionId"  TEXT,
    "recipient"       TEXT NOT NULL,
    "amount"          TEXT NOT NULL,
    "tokenSymbol"     TEXT,
    "windowLabel"     TEXT NOT NULL DEFAULT 'Corporate Yield Distribution Sync',
    "ledgerSequence"  INTEGER NOT NULL,
    "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YieldDistribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "YieldDistribution_contractAddress_idx"
    ON "YieldDistribution"("contractAddress");

CREATE INDEX "YieldDistribution_contractAddress_windowLabel_idx"
    ON "YieldDistribution"("contractAddress", "windowLabel");

CREATE INDEX "YieldDistribution_contractAddress_ledgerCloseTime_idx"
    ON "YieldDistribution"("contractAddress", "ledgerCloseTime");

CREATE INDEX "YieldDistribution_windowLabel_idx"
    ON "YieldDistribution"("windowLabel");

CREATE INDEX "YieldDistribution_distributionId_idx"
    ON "YieldDistribution"("distributionId");
