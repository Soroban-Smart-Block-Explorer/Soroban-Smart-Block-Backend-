-- Formal Verification Integration

CREATE TYPE "FormalVerifTool" AS ENUM (
  'certora', 'scribble', 'halo2', 'smtchecker', 'manual'
);

CREATE TABLE "FormalVerificationJob" (
  "id"               TEXT        NOT NULL PRIMARY KEY,
  "contractAddress"  TEXT        NOT NULL,
  "tool"             "FormalVerifTool" NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'pending',
  "sourceJobId"      TEXT,
  "specContent"      TEXT,
  "specFileName"     TEXT,
  "toolVersion"      TEXT,
  "toolOptions"      JSONB,
  "passed"           BOOLEAN,
  "propertyCount"    INTEGER,
  "provenCount"      INTEGER,
  "violatedCount"    INTEGER,
  "unknownCount"     INTEGER,
  "counterExamples"  JSONB,
  "coveragePercent"  DOUBLE PRECISION,
  "toolOutput"       TEXT,
  "reportUrl"        TEXT,
  "startedAt"        TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "durationSeconds"  INTEGER,
  "certId"           TEXT,
  "triggeredBy"      TEXT        NOT NULL DEFAULT 'manual',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "FormalVerificationJob_contractAddress_idx"
  ON "FormalVerificationJob"("contractAddress");
CREATE INDEX "FormalVerificationJob_tool_idx"
  ON "FormalVerificationJob"("tool");
CREATE INDEX "FormalVerificationJob_status_idx"
  ON "FormalVerificationJob"("status");
CREATE INDEX "FormalVerificationJob_createdAt_idx"
  ON "FormalVerificationJob"("createdAt" DESC);
