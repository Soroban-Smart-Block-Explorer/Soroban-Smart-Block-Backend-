-- CreateEnum
CREATE TYPE "MevType" AS ENUM ('sandwich', 'flash_loan_attack', 'backrunning', 'displacement', 'jit_liquidity', 'cex_dex_arbitrage', 'cross_dex_arbitrage', 'liquidation', 'nft_mev');

-- CreateEnum
CREATE TYPE "MevAlertType" AS ENUM ('sandwich_in_progress', 'sandwich_detected', 'mev_spike', 'protocol_targeted', 'user_victim');

-- CreateEnum
CREATE TYPE "MevSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateTable
CREATE TABLE "MevVictim" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "totalLossUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "incidentCount" INTEGER NOT NULL DEFAULT 0,
    "lastIncidentAt" TIMESTAMP(3),
    "firstIncidentAt" TIMESTAMP(3),
    "protectionScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MevVictim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MevAttacker" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "totalProfitUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attackCount" INTEGER NOT NULL DEFAULT 0,
    "favoriteType" "MevType",
    "lastAttackAt" TIMESTAMP(3),
    "firstSeen" TIMESTAMP(3),
    "isContract" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MevAttacker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MevEvent" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledgerSeq" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "mevType" "MevType" NOT NULL,
    "victimAddress" TEXT,
    "attackerAddress" TEXT,
    "protocolAddress" TEXT,
    "tokenIn" TEXT,
    "tokenOut" TEXT,
    "amountIn" TEXT,
    "amountOut" TEXT,
    "profitAmount" TEXT,
    "profitUsd" DOUBLE PRECISION,
    "lossAmount" TEXT,
    "lossUsd" DOUBLE PRECISION,
    "txOrder" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MevEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolMevResistance" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "contractName" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "commitReveal" BOOLEAN NOT NULL DEFAULT false,
    "batchAuctions" BOOLEAN NOT NULL DEFAULT false,
    "slippageDefault" DOUBLE PRECISION,
    "privateMempool" BOOLEAN NOT NULL DEFAULT false,
    "encryptedTxs" BOOLEAN NOT NULL DEFAULT false,
    "mevExtractedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalIncidents" INTEGER NOT NULL DEFAULT 0,
    "lastIncidentAt" TIMESTAMP(3),
    "scoreHistory" JSONB,
    "recommendations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolMevResistance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MevAlert" (
    "id" TEXT NOT NULL,
    "alertType" "MevAlertType" NOT NULL,
    "severity" "MevSeverity" NOT NULL,
    "txHash" TEXT,
    "victimAddress" TEXT,
    "protocolAddress" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "estimatedLoss" DOUBLE PRECISION,
    "recommendedAction" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MevAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MevVictim_address_key" ON "MevVictim"("address");

-- CreateIndex
CREATE INDEX "MevVictim_address_idx" ON "MevVictim"("address");

-- CreateIndex
CREATE UNIQUE INDEX "MevAttacker_address_key" ON "MevAttacker"("address");

-- CreateIndex
CREATE INDEX "MevAttacker_address_idx" ON "MevAttacker"("address");

-- CreateIndex
CREATE INDEX "MevAttacker_totalProfitUsd_idx" ON "MevAttacker"("totalProfitUsd");

-- CreateIndex
CREATE UNIQUE INDEX "MevEvent_txHash_key" ON "MevEvent"("txHash");

-- CreateIndex
CREATE INDEX "MevEvent_mevType_idx" ON "MevEvent"("mevType");

-- CreateIndex
CREATE INDEX "MevEvent_ledgerSeq_idx" ON "MevEvent"("ledgerSeq");

-- CreateIndex
CREATE INDEX "MevEvent_victimAddress_idx" ON "MevEvent"("victimAddress");

-- CreateIndex
CREATE INDEX "MevEvent_attackerAddress_idx" ON "MevEvent"("attackerAddress");

-- CreateIndex
CREATE INDEX "MevEvent_protocolAddress_idx" ON "MevEvent"("protocolAddress");

-- CreateIndex
CREATE INDEX "MevEvent_createdAt_idx" ON "MevEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolMevResistance_contractAddress_key" ON "ProtocolMevResistance"("contractAddress");

-- CreateIndex
CREATE INDEX "ProtocolMevResistance_contractAddress_idx" ON "ProtocolMevResistance"("contractAddress");

-- CreateIndex
CREATE INDEX "ProtocolMevResistance_score_idx" ON "ProtocolMevResistance"("score");

-- CreateIndex
CREATE INDEX "MevAlert_alertType_idx" ON "MevAlert"("alertType");

-- CreateIndex
CREATE INDEX "MevAlert_severity_idx" ON "MevAlert"("severity");

-- CreateIndex
CREATE INDEX "MevAlert_victimAddress_idx" ON "MevAlert"("victimAddress");

-- CreateIndex
CREATE INDEX "MevAlert_acknowledged_idx" ON "MevAlert"("acknowledged");

-- CreateIndex
CREATE INDEX "MevAlert_createdAt_idx" ON "MevAlert"("createdAt");

-- AddForeignKey
ALTER TABLE "MevEvent" ADD CONSTRAINT "MevEvent_victimAddress_fkey" FOREIGN KEY ("victimAddress") REFERENCES "MevVictim"("address") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MevEvent" ADD CONSTRAINT "MevEvent_attackerAddress_fkey" FOREIGN KEY ("attackerAddress") REFERENCES "MevAttacker"("address") ON DELETE SET NULL ON UPDATE CASCADE;
