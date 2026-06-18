-- CAP-0077: Consensus Asset-Freeze Transaction Interceptor

-- Frozen ledger key registry
CREATE TABLE "FrozenLedgerKey" (
    "id"             TEXT NOT NULL,
    "ledgerKey"      TEXT NOT NULL,
    "contractAddress" TEXT,
    "frozenAtLedger" INTEGER NOT NULL,
    "frozenAtTime"   TIMESTAMP(3) NOT NULL,
    "reason"         TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FrozenLedgerKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FrozenLedgerKey_ledgerKey_key" ON "FrozenLedgerKey"("ledgerKey");
CREATE INDEX "FrozenLedgerKey_contractAddress_idx" ON "FrozenLedgerKey"("contractAddress");
CREATE INDEX "FrozenLedgerKey_active_idx" ON "FrozenLedgerKey"("active");
CREATE INDEX "FrozenLedgerKey_frozenAtLedger_idx" ON "FrozenLedgerKey"("frozenAtLedger");

-- Transactions that touched a frozen key
CREATE TABLE "FreezeViolation" (
    "id"              TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "contractAddress" TEXT,
    "ledgerSequence"  INTEGER NOT NULL,
    "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
    "frozenKeys"      JSONB NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FreezeViolation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FreezeViolation_transactionHash_key" ON "FreezeViolation"("transactionHash");
CREATE INDEX "FreezeViolation_contractAddress_idx" ON "FreezeViolation"("contractAddress");
CREATE INDEX "FreezeViolation_ledgerSequence_idx" ON "FreezeViolation"("ledgerSequence");

-- Add freezeViolation flag to Transaction
ALTER TABLE "Transaction" ADD COLUMN "freezeViolation" BOOLEAN NOT NULL DEFAULT false;
