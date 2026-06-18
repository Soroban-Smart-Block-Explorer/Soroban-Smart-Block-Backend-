-- Protocol 26 State Extension Analysis Tracking
-- Adds tables to store detailed state extension analysis results

-- State Extension Analysis Results
CREATE TABLE IF NOT EXISTS "StateExtensionAnalysis" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "transactionHash" TEXT NOT NULL UNIQUE,
  "contractAddress" TEXT NOT NULL,
  "ledgerSequence" INTEGER NOT NULL,
  "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
  
  -- Raw parameters
  "extend_to" TEXT,
  "min_extension" TEXT,
  "max_extension" TEXT,
  
  -- Extension range metrics
  "extensionRangeMin" TEXT NOT NULL,
  "extensionRangeMax" TEXT NOT NULL,
  "extensionRangeSpread" TEXT NOT NULL,
  "extensionRangeSpreadPercent" DOUBLE PRECISION NOT NULL,
  
  -- Clamping analysis
  "networkMaxExtension" TEXT NOT NULL,
  "contractMaxExtension" TEXT NOT NULL,
  "clampingRatio" DOUBLE PRECISION NOT NULL,
  "isClamped" BOOLEAN NOT NULL,
  "clampingTightness" TEXT NOT NULL, -- 'loose' | 'moderate' | 'tight' | 'extreme'
  
  -- Equity metrics
  "rentTopUpAmount" TEXT NOT NULL,
  "topUpPerLedger" DOUBLE PRECISION NOT NULL,
  "fairnessScore" INTEGER NOT NULL,
  "complianceStatus" TEXT NOT NULL, -- 'compliant' | 'warning' | 'violation'
  
  -- Historical context
  "previousExtensionLedger" INTEGER,
  "extensionFrequency" TEXT NOT NULL, -- 'frequent' | 'moderate' | 'rare'
  "averageExtensionSize" TEXT,
  
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient querying
CREATE INDEX "StateExtensionAnalysis_transactionHash_idx" ON "StateExtensionAnalysis"("transactionHash");
CREATE INDEX "StateExtensionAnalysis_contractAddress_idx" ON "StateExtensionAnalysis"("contractAddress");
CREATE INDEX "StateExtensionAnalysis_ledgerSequence_idx" ON "StateExtensionAnalysis"("ledgerSequence");
CREATE INDEX "StateExtensionAnalysis_complianceStatus_idx" ON "StateExtensionAnalysis"("complianceStatus");
CREATE INDEX "StateExtensionAnalysis_clampingTightness_idx" ON "StateExtensionAnalysis"("clampingTightness");
CREATE INDEX "StateExtensionAnalysis_fairnessScore_idx" ON "StateExtensionAnalysis"("fairnessScore");
CREATE INDEX "StateExtensionAnalysis_contractAddress_ledgerSequence_idx" ON "StateExtensionAnalysis"("contractAddress", "ledgerSequence" DESC);

-- State Extension Compliance Violations Log
CREATE TABLE IF NOT EXISTS "StateExtensionViolation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "analysisId" TEXT NOT NULL,
  "contractAddress" TEXT NOT NULL,
  "transactionHash" TEXT NOT NULL,
  "ledgerSequence" INTEGER NOT NULL,
  "violationType" TEXT NOT NULL, -- 'extreme_clamping' | 'unfair_topup' | 'threshold_breach'
  "severity" TEXT NOT NULL, -- 'critical' | 'high' | 'medium' | 'low'
  "description" TEXT NOT NULL,
  "recommendedAction" TEXT,
  "reviewed" BOOLEAN NOT NULL DEFAULT FALSE,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "notes" TEXT,
  
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY ("analysisId") REFERENCES "StateExtensionAnalysis"("id") ON DELETE CASCADE
);

CREATE INDEX "StateExtensionViolation_contractAddress_idx" ON "StateExtensionViolation"("contractAddress");
CREATE INDEX "StateExtensionViolation_violationType_idx" ON "StateExtensionViolation"("violationType");
CREATE INDEX "StateExtensionViolation_severity_idx" ON "StateExtensionViolation"("severity");
CREATE INDEX "StateExtensionViolation_reviewed_idx" ON "StateExtensionViolation"("reviewed");
CREATE INDEX "StateExtensionViolation_ledgerSequence_idx" ON "StateExtensionViolation"("ledgerSequence");

-- Contract State Extension Profile
-- Aggregated metrics per contract
CREATE TABLE IF NOT EXISTS "ContractStateExtensionProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contractAddress" TEXT NOT NULL UNIQUE,
  "totalExtensionCalls" INTEGER NOT NULL DEFAULT 0,
  "averageFairnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "averageClampingRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "violationCount" INTEGER NOT NULL DEFAULT 0,
  "extremeClampingCount" INTEGER NOT NULL DEFAULT 0,
  "lastAnalyzedLedger" INTEGER,
  "riskLevel" TEXT NOT NULL DEFAULT 'low', -- 'critical' | 'high' | 'medium' | 'low'
  "complianceStatus" TEXT NOT NULL DEFAULT 'compliant', -- 'compliant' | 'warning' | 'violation'
  
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ContractStateExtensionProfile_contractAddress_idx" ON "ContractStateExtensionProfile"("contractAddress");
CREATE INDEX "ContractStateExtensionProfile_riskLevel_idx" ON "ContractStateExtensionProfile"("riskLevel");
CREATE INDEX "ContractStateExtensionProfile_complianceStatus_idx" ON "ContractStateExtensionProfile"("complianceStatus");

-- State Extension Metrics Snapshot
-- Periodic snapshots of aggregate metrics
CREATE TABLE IF NOT EXISTS "StateExtensionMetricsSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ledgerSequence" INTEGER NOT NULL,
  "ledgerCloseTime" TIMESTAMP(3) NOT NULL,
  "totalExtensionCalls" INTEGER NOT NULL,
  "contractsUsingExtension" INTEGER NOT NULL,
  "averageClampingRatio" DOUBLE PRECISION NOT NULL,
  "tightClampingCount" INTEGER NOT NULL,
  "violationCount" INTEGER NOT NULL,
  "excellentEquityCount" INTEGER NOT NULL,
  "goodEquityCount" INTEGER NOT NULL,
  "fairEquityCount" INTEGER NOT NULL,
  "poorEquityCount" INTEGER NOT NULL,
  "criticalEquityCount" INTEGER NOT NULL,
  
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "StateExtensionMetricsSnapshot_ledgerSequence_idx" ON "StateExtensionMetricsSnapshot"("ledgerSequence" DESC);
CREATE INDEX "StateExtensionMetricsSnapshot_ledgerCloseTime_idx" ON "StateExtensionMetricsSnapshot"("ledgerCloseTime" DESC);
