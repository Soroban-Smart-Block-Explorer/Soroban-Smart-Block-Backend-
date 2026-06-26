-- Account Abstraction: SmartWallet, SponsoredTransaction, AuthDecomposition

CREATE TABLE "SmartWallet" (
    "id"                 TEXT NOT NULL,
    "address"            TEXT NOT NULL,
    "walletType"         TEXT NOT NULL,
    "signerCount"        INTEGER,
    "threshold"          INTEGER,
    "guardians"          JSONB,
    "sessionKeys"        JSONB,
    "authMethods"        JSONB,
    "deployedAtLedger"   INTEGER,
    "deployedByAccount"  TEXT,
    "wasmHash"           TEXT,
    "firstSeenLedger"    INTEGER NOT NULL,
    "lastSeenLedger"     INTEGER NOT NULL,
    "txCount"            INTEGER NOT NULL DEFAULT 0,
    "sponsoredTxCount"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmartWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmartWallet_address_key" ON "SmartWallet"("address");
CREATE INDEX "SmartWallet_walletType_idx"       ON "SmartWallet"("walletType");
CREATE INDEX "SmartWallet_firstSeenLedger_idx"  ON "SmartWallet"("firstSeenLedger");
CREATE INDEX "SmartWallet_deployedByAccount_idx" ON "SmartWallet"("deployedByAccount");

CREATE TABLE "SponsoredTransaction" (
    "id"              TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "sponsorAccount"  TEXT NOT NULL,
    "sourceAccount"   TEXT NOT NULL,
    "walletAddress"   TEXT,
    "feeCharged"      TEXT,
    "ledgerSequence"  INTEGER NOT NULL,
    "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SponsoredTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SponsoredTransaction_transactionHash_key" ON "SponsoredTransaction"("transactionHash");
CREATE INDEX "SponsoredTransaction_sponsorAccount_idx"  ON "SponsoredTransaction"("sponsorAccount");
CREATE INDEX "SponsoredTransaction_sourceAccount_idx"   ON "SponsoredTransaction"("sourceAccount");
CREATE INDEX "SponsoredTransaction_walletAddress_idx"   ON "SponsoredTransaction"("walletAddress");
CREATE INDEX "SponsoredTransaction_ledgerSequence_idx"  ON "SponsoredTransaction"("ledgerSequence");

ALTER TABLE "SponsoredTransaction"
    ADD CONSTRAINT "SponsoredTransaction_walletAddress_fkey"
    FOREIGN KEY ("walletAddress") REFERENCES "SmartWallet"("address")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AuthDecomposition" (
    "id"              TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "walletAddress"   TEXT,
    "authTree"        JSONB NOT NULL,
    "authMethods"     JSONB NOT NULL,
    "signerCount"     INTEGER NOT NULL DEFAULT 0,
    "hasSubCalls"     BOOLEAN NOT NULL DEFAULT false,
    "humanReadable"   TEXT,
    "ledgerSequence"  INTEGER NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthDecomposition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthDecomposition_transactionHash_key" ON "AuthDecomposition"("transactionHash");
CREATE INDEX "AuthDecomposition_walletAddress_idx"          ON "AuthDecomposition"("walletAddress");
CREATE INDEX "AuthDecomposition_ledgerSequence_idx"         ON "AuthDecomposition"("ledgerSequence");
CREATE INDEX "AuthDecomposition_ledgerSequence_id_idx"      ON "AuthDecomposition"("ledgerSequence", "id");
