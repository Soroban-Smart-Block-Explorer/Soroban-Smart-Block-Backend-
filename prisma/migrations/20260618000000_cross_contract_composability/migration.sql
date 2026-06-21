-- Cross-Contract Composability Analyzer Migration

CREATE TYPE "RiskLevel" AS ENUM ('safe', 'low_risk', 'medium_risk', 'high_risk', 'critical');
CREATE TYPE "AnalysisStatus" AS ENUM ('pending', 'analyzing', 'completed', 'failed');
CREATE TYPE "ComposabilityAlertSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- ComposedTransaction
CREATE TABLE "ComposedTransaction" (
    "id"             TEXT NOT NULL,
    "txHash"         TEXT NOT NULL,
    "ledgerSeq"      INTEGER NOT NULL,
    "timestamp"      TIMESTAMP(3) NOT NULL,
    "contractCalls"  JSONB,
    "callGraph"      JSONB,
    "safetyScore"    DOUBLE PRECISION,
    "riskLevel"      "RiskLevel",
    "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'pending',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComposedTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComposedTransaction_txHash_key" ON "ComposedTransaction"("txHash");
CREATE INDEX "ComposedTransaction_ledgerSeq_idx" ON "ComposedTransaction"("ledgerSeq");
CREATE INDEX "ComposedTransaction_riskLevel_idx" ON "ComposedTransaction"("riskLevel");
CREATE INDEX "ComposedTransaction_analysisStatus_idx" ON "ComposedTransaction"("analysisStatus");

-- CompositionPattern
CREATE TABLE "CompositionPattern" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT NOT NULL,
    "category"        TEXT NOT NULL,
    "riskRating"      "RiskLevel" NOT NULL DEFAULT 'medium_risk',
    "requiredCalls"   INTEGER NOT NULL DEFAULT 2,
    "detectionRules"  JSONB,
    "safeIf"          JSONB,
    "mitigationGuide" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompositionPattern_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CompositionPattern_name_key" ON "CompositionPattern"("name");
CREATE INDEX "CompositionPattern_category_idx" ON "CompositionPattern"("category");
CREATE INDEX "CompositionPattern_riskRating_idx" ON "CompositionPattern"("riskRating");

-- CompositionPatternInstance
CREATE TABLE "CompositionPatternInstance" (
    "id"        TEXT NOT NULL,
    "txId"      TEXT NOT NULL,
    "patternId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "details"   JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompositionPatternInstance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompositionPatternInstance_txId_idx" ON "CompositionPatternInstance"("txId");
CREATE INDEX "CompositionPatternInstance_patternId_idx" ON "CompositionPatternInstance"("patternId");

-- ContractComposability
CREATE TABLE "ContractComposability" (
    "id"                  TEXT NOT NULL,
    "contractId"          TEXT NOT NULL,
    "contractAddress"     TEXT NOT NULL,
    "composedWith"        JSONB,
    "compositionCount"    INTEGER NOT NULL DEFAULT 0,
    "uniqueCallers"       INTEGER NOT NULL DEFAULT 0,
    "uniqueCallees"       INTEGER NOT NULL DEFAULT 0,
    "avgCompositionDepth" DOUBLE PRECISION,
    "safetyScoreAvg"      DOUBLE PRECISION,
    "riskIncidents"       INTEGER NOT NULL DEFAULT 0,
    "lastAnalyzed"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContractComposability_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContractComposability_contractAddress_key" ON "ContractComposability"("contractAddress");
CREATE INDEX "ContractComposability_contractAddress_idx" ON "ContractComposability"("contractAddress");
CREATE INDEX "ContractComposability_riskIncidents_idx" ON "ContractComposability"("riskIncidents");

-- CompositionAlert
CREATE TABLE "CompositionAlert" (
    "id"              TEXT NOT NULL,
    "txHash"          TEXT,
    "contractAddress" TEXT,
    "patternId"       TEXT,
    "severity"        "ComposabilityAlertSeverity" NOT NULL,
    "title"           TEXT NOT NULL,
    "description"     TEXT NOT NULL,
    "exploitDetected" BOOLEAN NOT NULL DEFAULT false,
    "mitigated"       BOOLEAN NOT NULL DEFAULT false,
    "mitigationPatch" JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"      TIMESTAMP(3),
    CONSTRAINT "CompositionAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompositionAlert_txHash_idx" ON "CompositionAlert"("txHash");
CREATE INDEX "CompositionAlert_contractAddress_idx" ON "CompositionAlert"("contractAddress");
CREATE INDEX "CompositionAlert_severity_idx" ON "CompositionAlert"("severity");
CREATE INDEX "CompositionAlert_exploitDetected_idx" ON "CompositionAlert"("exploitDetected");

-- ComposabilityStaticAnalysis
CREATE TABLE "ComposabilityStaticAnalysis" (
    "id"                    TEXT NOT NULL,
    "contractAddress"       TEXT NOT NULL,
    "externalCalls"         JSONB,
    "callGraph"             JSONB,
    "circularDeps"          JSONB,
    "hasUnboundedRecursion" BOOLEAN NOT NULL DEFAULT false,
    "maxCallDepth"          INTEGER NOT NULL DEFAULT 0,
    "analysisVersion"       TEXT NOT NULL DEFAULT '1.0',
    "analyzedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComposabilityStaticAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComposabilityStaticAnalysis_contractAddress_key" ON "ComposabilityStaticAnalysis"("contractAddress");

-- ComposabilityVerification
CREATE TABLE "ComposabilityVerification" (
    "id"                TEXT NOT NULL,
    "txHash"            TEXT NOT NULL,
    "atomicity"         BOOLEAN NOT NULL DEFAULT false,
    "authorization"     BOOLEAN NOT NULL DEFAULT false,
    "stateConsistency"  BOOLEAN NOT NULL DEFAULT false,
    "reentrancyFree"    BOOLEAN NOT NULL DEFAULT false,
    "oracleFreshness"   BOOLEAN NOT NULL DEFAULT false,
    "atomicityScore"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "authorizationScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stateScore"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reentrancyScore"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oracleScore"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalScore"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proofData"         JSONB,
    "verified"          BOOLEAN NOT NULL DEFAULT false,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComposabilityVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComposabilityVerification_txHash_key" ON "ComposabilityVerification"("txHash");
CREATE INDEX "ComposabilityVerification_verified_idx" ON "ComposabilityVerification"("verified");

-- ComposabilityFuzzCampaign
CREATE TABLE "ComposabilityFuzzCampaign" (
    "id"              TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'running',
    "totalCases"      INTEGER NOT NULL DEFAULT 0,
    "unsafeFound"     INTEGER NOT NULL DEFAULT 0,
    "falsePositives"  INTEGER NOT NULL DEFAULT 0,
    "coveragePct"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "findings"        JSONB,
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"     TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComposabilityFuzzCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComposabilityFuzzCampaign_contractAddress_idx" ON "ComposabilityFuzzCampaign"("contractAddress");
CREATE INDEX "ComposabilityFuzzCampaign_status_idx" ON "ComposabilityFuzzCampaign"("status");

-- ComposabilityExploit
CREATE TABLE "ComposabilityExploit" (
    "id"               TEXT NOT NULL,
    "title"            TEXT NOT NULL,
    "description"      TEXT NOT NULL,
    "patternCategory"  TEXT NOT NULL,
    "cveId"            TEXT,
    "affectedContracts" TEXT[],
    "exploitTxHashes"  TEXT[],
    "advisoryUrl"      TEXT,
    "severity"         "ComposabilityAlertSeverity" NOT NULL,
    "discoveredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComposabilityExploit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComposabilityExploit_patternCategory_idx" ON "ComposabilityExploit"("patternCategory");
CREATE INDEX "ComposabilityExploit_severity_idx" ON "ComposabilityExploit"("severity");

-- EcosystemComposabilityIndex
CREATE TABLE "EcosystemComposabilityIndex" (
    "id"                        TEXT NOT NULL,
    "score"                     DOUBLE PRECISION NOT NULL,
    "compositionDiversity"      INTEGER NOT NULL DEFAULT 0,
    "avgSafetyScore"            DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exploitIncidentRate"       DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocolInterconnectivity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalContracts"            INTEGER NOT NULL DEFAULT 0,
    "totalComposedTx"           INTEGER NOT NULL DEFAULT 0,
    "computedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EcosystemComposabilityIndex_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EcosystemComposabilityIndex_computedAt_idx" ON "EcosystemComposabilityIndex"("computedAt");

-- Foreign keys
ALTER TABLE "CompositionPatternInstance"
    ADD CONSTRAINT "CompositionPatternInstance_txId_fkey"
    FOREIGN KEY ("txId") REFERENCES "ComposedTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CompositionPatternInstance"
    ADD CONSTRAINT "CompositionPatternInstance_patternId_fkey"
    FOREIGN KEY ("patternId") REFERENCES "CompositionPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CompositionAlert"
    ADD CONSTRAINT "CompositionAlert_patternId_fkey"
    FOREIGN KEY ("patternId") REFERENCES "CompositionPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;
