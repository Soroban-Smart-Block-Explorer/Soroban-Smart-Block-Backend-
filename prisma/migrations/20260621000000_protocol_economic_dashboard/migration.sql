-- Issue #301: Protocol Economic Dashboard
-- Pre-aggregated protocol economics: total fees, fee burn, and network revenue per time bucket.

CREATE TABLE "ProtocolEconomicsSnapshot" (
    "id"             TEXT NOT NULL,
    "bucket"         TEXT NOT NULL,              -- 'hour' | 'day' | 'week'
    "bucketStart"    TIMESTAMP(3) NOT NULL,
    "bucketEnd"      TIMESTAMP(3) NOT NULL,
    "txCount"        INTEGER NOT NULL,
    "totalFees"      DOUBLE PRECISION NOT NULL,  -- sum of feeCharged (stroops)
    "feeBurn"        DOUBLE PRECISION NOT NULL,  -- BASE_FEE(100) * txCount (estimated burn)
    "networkRevenue" DOUBLE PRECISION NOT NULL,  -- totalFees - feeBurn
    "avgFee"         DOUBLE PRECISION NOT NULL,
    "successCount"   INTEGER NOT NULL,
    "failedCount"    INTEGER NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolEconomicsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProtocolEconomicsSnapshot_bucket_bucketStart_key"
    ON "ProtocolEconomicsSnapshot"("bucket", "bucketStart");

CREATE INDEX "ProtocolEconomicsSnapshot_bucket_bucketStart_idx"
    ON "ProtocolEconomicsSnapshot"("bucket", "bucketStart");
