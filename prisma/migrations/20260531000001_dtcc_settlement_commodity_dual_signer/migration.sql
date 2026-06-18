-- #218: DTCC Tokenized Securities Settlement ID Bridge
CREATE TABLE "DtccSettlementBridge" (
    "id"                 TEXT NOT NULL,
    "transactionHash"    TEXT NOT NULL,
    "dtccSettlementId"   TEXT NOT NULL,
    "securityId"         TEXT NOT NULL,
    "securityType"       TEXT NOT NULL,
    "sellerAddress"      TEXT NOT NULL,
    "buyerAddress"       TEXT NOT NULL,
    "quantity"           TEXT NOT NULL,
    "settlementAmount"   TEXT NOT NULL,
    "currency"           TEXT NOT NULL DEFAULT 'USD',
    "settlementStatus"   TEXT NOT NULL DEFAULT 'pending',
    "settlementDate"     TIMESTAMP(3),
    "contractAddress"    TEXT,
    "ledgerSequence"     INTEGER NOT NULL,
    "ledgerCloseTime"    TIMESTAMP(3) NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DtccSettlementBridge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DtccSettlementBridge_transactionHash_key" ON "DtccSettlementBridge"("transactionHash");
CREATE INDEX "DtccSettlementBridge_dtccSettlementId_idx" ON "DtccSettlementBridge"("dtccSettlementId");
CREATE INDEX "DtccSettlementBridge_securityId_idx" ON "DtccSettlementBridge"("securityId");
CREATE INDEX "DtccSettlementBridge_sellerAddress_idx" ON "DtccSettlementBridge"("sellerAddress");
CREATE INDEX "DtccSettlementBridge_buyerAddress_idx" ON "DtccSettlementBridge"("buyerAddress");
CREATE INDEX "DtccSettlementBridge_settlementStatus_idx" ON "DtccSettlementBridge"("settlementStatus");
CREATE INDEX "DtccSettlementBridge_ledgerSequence_idx" ON "DtccSettlementBridge"("ledgerSequence");

-- #219: Commodity Compliance Dual-Signer Verification Log
CREATE TABLE "CommodityDualSignerLog" (
    "id"                       TEXT NOT NULL,
    "transactionHash"          TEXT NOT NULL,
    "commodityType"            TEXT NOT NULL,
    "commodityCode"            TEXT NOT NULL,
    "contractAddress"          TEXT NOT NULL,
    "traderAddress"            TEXT NOT NULL,
    "primarySignerAddress"     TEXT NOT NULL,
    "secondarySignerAddress"   TEXT NOT NULL,
    "primarySigned"            BOOLEAN NOT NULL DEFAULT false,
    "secondarySigned"          BOOLEAN NOT NULL DEFAULT false,
    "bothSigned"               BOOLEAN NOT NULL DEFAULT false,
    "quantity"                 TEXT NOT NULL,
    "unit"                     TEXT NOT NULL,
    "notionalValueUsd"         TEXT,
    "regulatoryJurisdiction"   TEXT NOT NULL DEFAULT 'CFTC',
    "complianceStatus"         TEXT NOT NULL DEFAULT 'pending',
    "expiresAt"                TIMESTAMP(3),
    "ledgerSequence"           INTEGER NOT NULL,
    "ledgerCloseTime"          TIMESTAMP(3) NOT NULL,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommodityDualSignerLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommodityDualSignerLog_transactionHash_key" ON "CommodityDualSignerLog"("transactionHash");
CREATE INDEX "CommodityDualSignerLog_commodityCode_idx" ON "CommodityDualSignerLog"("commodityCode");
CREATE INDEX "CommodityDualSignerLog_contractAddress_idx" ON "CommodityDualSignerLog"("contractAddress");
CREATE INDEX "CommodityDualSignerLog_traderAddress_idx" ON "CommodityDualSignerLog"("traderAddress");
CREATE INDEX "CommodityDualSignerLog_primarySignerAddress_idx" ON "CommodityDualSignerLog"("primarySignerAddress");
CREATE INDEX "CommodityDualSignerLog_secondarySignerAddress_idx" ON "CommodityDualSignerLog"("secondarySignerAddress");
CREATE INDEX "CommodityDualSignerLog_complianceStatus_idx" ON "CommodityDualSignerLog"("complianceStatus");
CREATE INDEX "CommodityDualSignerLog_ledgerSequence_idx" ON "CommodityDualSignerLog"("ledgerSequence");
