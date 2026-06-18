-- Migration: #168 AccountActivation table
-- Tracks XLM SAC transfers that activate previously unfunded base accounts.

CREATE TABLE "AccountActivation" (
    "id"              TEXT NOT NULL,
    "destination"     TEXT NOT NULL,
    "sacAddress"      TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "ledgerSequence"  INTEGER NOT NULL,
    "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
    "amountStroops"   TEXT NOT NULL,
    "previousStatus"  TEXT NOT NULL DEFAULT 'Unfunded Key',
    "newStatus"       TEXT NOT NULL DEFAULT 'Active Base Wallet Natively Initialized',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountActivation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountActivation_transactionHash_destination_key"
    ON "AccountActivation"("transactionHash", "destination");

CREATE INDEX "AccountActivation_destination_idx"
    ON "AccountActivation"("destination");

CREATE INDEX "AccountActivation_sacAddress_idx"
    ON "AccountActivation"("sacAddress");

CREATE INDEX "AccountActivation_ledgerSequence_idx"
    ON "AccountActivation"("ledgerSequence");
