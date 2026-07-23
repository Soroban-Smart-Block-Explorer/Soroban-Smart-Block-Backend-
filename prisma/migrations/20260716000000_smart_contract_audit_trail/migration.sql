-- Smart Contract Audit Trail & Certificate Platform
-- Continuous audit with cryptographic attestation and regulatory-grade reporting

-- ── AuditCertificate ─────────────────────────────────────────────────────────
CREATE TABLE "AuditCertificate" (
  "id"                 TEXT NOT NULL PRIMARY KEY,
  "contractAddress"    TEXT NOT NULL,
  "version"            INTEGER NOT NULL DEFAULT 1,
  "status"             TEXT NOT NULL,
  "generatedAt"        TIMESTAMP(3) NOT NULL,
  "expiresAt"          TIMESTAMP(3),
  "overallScore"       INTEGER NOT NULL,
  "securityScore"      INTEGER NOT NULL,
  "governanceScore"    INTEGER NOT NULL,
  "economicScore"      INTEGER NOT NULL,
  "complianceScore"    INTEGER NOT NULL,
  "liquidityScore"     INTEGER NOT NULL,
  "signatureAlgorithm" TEXT NOT NULL,
  "signature"          TEXT NOT NULL,
  "publicKey"          TEXT NOT NULL,
  "certificateHash"    TEXT NOT NULL,
  "anchorTxHash"       TEXT,
  "totalFindings"      INTEGER NOT NULL DEFAULT 0,
  "openFindings"       INTEGER NOT NULL DEFAULT 0,
  "criticalFindings"   INTEGER NOT NULL DEFAULT 0,
  "highFindings"       INTEGER NOT NULL DEFAULT 0,
  "mediumFindings"     INTEGER NOT NULL DEFAULT 0,
  "lowFindings"        INTEGER NOT NULL DEFAULT 0,
  "resolvedFindings"   INTEGER NOT NULL DEFAULT 0,
  "findings"           JSONB NOT NULL DEFAULT '[]',
  "scores"             JSONB NOT NULL DEFAULT '{}',
  "metadata"           JSONB,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AuditCertificate_contractAddress_version_key"
  ON "AuditCertificate"("contractAddress", "version");
CREATE INDEX "AuditCertificate_contractAddress_status_idx"
  ON "AuditCertificate"("contractAddress", "status");
CREATE INDEX "AuditCertificate_overallScore_idx"
  ON "AuditCertificate"("overallScore" DESC);
CREATE INDEX "AuditCertificate_createdAt_idx"
  ON "AuditCertificate"("createdAt" DESC);

-- ── AuditFinding ──────────────────────────────────────────────────────────────
CREATE TABLE "AuditFinding" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "certificateId"  TEXT NOT NULL,
  "category"       TEXT NOT NULL,
  "severity"       TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "detail"         TEXT,
  "recommendation" TEXT,
  "status"         TEXT NOT NULL,
  "resolvedAt"     TIMESTAMP(3),
  "resolutionNote" TEXT,
  "cweId"          TEXT,
  "cvssVector"     TEXT,
  "cvssScore"      DOUBLE PRECISION,
  "txHash"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("certificateId") REFERENCES "AuditCertificate"("id") ON DELETE CASCADE
);

CREATE INDEX "AuditFinding_certificateId_idx"  ON "AuditFinding"("certificateId");
CREATE INDEX "AuditFinding_severity_status_idx" ON "AuditFinding"("severity", "status");
CREATE INDEX "AuditFinding_category_idx"        ON "AuditFinding"("category");

-- ── AuditEvent ────────────────────────────────────────────────────────────────
CREATE TABLE "AuditEvent" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "contractAddress" TEXT NOT NULL,
  "certificateId"   TEXT,
  "eventType"       TEXT NOT NULL,
  "previousScore"   INTEGER,
  "newScore"        INTEGER,
  "triggerSource"   TEXT NOT NULL,
  "details"         JSONB,
  "timestamp"       TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("certificateId") REFERENCES "AuditCertificate"("id")
);

CREATE INDEX "AuditEvent_contractAddress_timestamp_idx"
  ON "AuditEvent"("contractAddress", "timestamp" DESC);
CREATE INDEX "AuditEvent_eventType_idx"     ON "AuditEvent"("eventType");
CREATE INDEX "AuditEvent_certificateId_idx" ON "AuditEvent"("certificateId");

-- ── ExternalAudit ─────────────────────────────────────────────────────────────
CREATE TABLE "ExternalAudit" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "contractAddress"        TEXT NOT NULL,
  "auditorName"            TEXT NOT NULL,
  "auditorVerificationKey" TEXT,
  "reportType"             TEXT NOT NULL,
  "reportUrl"              TEXT,
  "reportHash"             TEXT,
  "findings"               JSONB,
  "overallGrade"           TEXT,
  "submittedAt"            TIMESTAMP(3) NOT NULL,
  "verifiedAt"             TIMESTAMP(3),
  "verificationStatus"     TEXT NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ExternalAudit_contractAddress_idx"
  ON "ExternalAudit"("contractAddress");
CREATE INDEX "ExternalAudit_verificationStatus_idx"
  ON "ExternalAudit"("verificationStatus");
CREATE INDEX "ExternalAudit_submittedAt_idx"
  ON "ExternalAudit"("submittedAt" DESC);

-- ── AuditSubscription ─────────────────────────────────────────────────────────
CREATE TABLE "AuditSubscription" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "userId"          TEXT,
  "contractAddress" TEXT NOT NULL,
  "alertTypes"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "threshold"       INTEGER,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuditSubscription_userId_idx"          ON "AuditSubscription"("userId");
CREATE INDEX "AuditSubscription_contractAddress_idx" ON "AuditSubscription"("contractAddress");
CREATE INDEX "AuditSubscription_isActive_idx"        ON "AuditSubscription"("isActive");

-- ── AuditVerificationRecord ───────────────────────────────────────────────────
CREATE TABLE "AuditVerificationRecord" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "certificateHash" TEXT NOT NULL,
  "verifierIp"      TEXT,
  "verifierKey"     TEXT,
  "result"          TEXT NOT NULL,
  "checkedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuditVerificationRecord_certificateHash_idx"
  ON "AuditVerificationRecord"("certificateHash");
CREATE INDEX "AuditVerificationRecord_checkedAt_idx"
  ON "AuditVerificationRecord"("checkedAt" DESC);
