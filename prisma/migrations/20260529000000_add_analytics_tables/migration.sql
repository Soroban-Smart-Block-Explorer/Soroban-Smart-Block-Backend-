-- Migration: add_analytics_tables
-- Adds GasAnalyticsSnapshot, PortfolioSnapshot, and VolumeAlert models

CREATE TABLE "GasAnalyticsSnapshot" (
    "id"          TEXT NOT NULL,
    "bucket"      TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd"   TIMESTAMP(3) NOT NULL,
    "avgFee"      DOUBLE PRECISION NOT NULL,
    "medianFee"   DOUBLE PRECISION NOT NULL,
    "peakFee"     DOUBLE PRECISION NOT NULL,
    "minFee"      DOUBLE PRECISION NOT NULL,
    "txCount"     INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GasAnalyticsSnapshot_bucket_bucketStart_key"
    ON "GasAnalyticsSnapshot"("bucket", "bucketStart");

CREATE INDEX "GasAnalyticsSnapshot_bucket_bucketStart_idx"
    ON "GasAnalyticsSnapshot"("bucket", "bucketStart");

-- PortfolioSnapshot

CREATE TABLE "PortfolioSnapshot" (
    "id"              TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "assetCode"       TEXT,
    "assetIssuer"     TEXT,
    "estimatedVolume" DOUBLE PRECISION NOT NULL,
    "priceXlm"        DOUBLE PRECISION,
    "priceUsd"        DOUBLE PRECISION,
    "valueXlm"        DOUBLE PRECISION,
    "valueUsd"        DOUBLE PRECISION,
    "snapshotAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortfolioSnapshot_contractAddress_idx"
    ON "PortfolioSnapshot"("contractAddress");

CREATE INDEX "PortfolioSnapshot_snapshotAt_idx"
    ON "PortfolioSnapshot"("snapshotAt");

-- VolumeAlert

CREATE TABLE "VolumeAlert" (
    "id"              TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "currentCount"    INTEGER NOT NULL,
    "baseline"        DOUBLE PRECISION NOT NULL,
    "stdDev"          DOUBLE PRECISION NOT NULL,
    "zScore"          DOUBLE PRECISION NOT NULL,
    "windowMinutes"   INTEGER NOT NULL,
    "detectedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged"    BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VolumeAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VolumeAlert_contractAddress_idx"
    ON "VolumeAlert"("contractAddress");

CREATE INDEX "VolumeAlert_detectedAt_idx"
    ON "VolumeAlert"("detectedAt");

CREATE INDEX "VolumeAlert_zScore_idx"
    ON "VolumeAlert"("zScore");
