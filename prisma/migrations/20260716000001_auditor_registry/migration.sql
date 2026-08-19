-- Third-Party Auditor Registry + ExternalAudit enhancements

-- ── AuditorRegistry ───────────────────────────────────────────────────────────
CREATE TABLE "AuditorRegistry" (
  "id"                  TEXT        NOT NULL PRIMARY KEY,
  "name"                TEXT        NOT NULL UNIQUE,
  "slug"                TEXT        NOT NULL UNIQUE,
  "website"             TEXT,
  "logoUrl"             TEXT,
  "description"         TEXT,
  "contactEmail"        TEXT,
  "twitterHandle"       TEXT,
  "githubOrg"           TEXT,
  "verificationKey"     TEXT        UNIQUE,
  "verificationKeyAlgo" TEXT,
  "isVerified"          BOOLEAN     NOT NULL DEFAULT false,
  "verifiedAt"          TIMESTAMP(3),
  "verifiedBy"          TEXT,
  "trustScore"          INTEGER     NOT NULL DEFAULT 50,
  "totalAudits"         INTEGER     NOT NULL DEFAULT 0,
  "acceptedAudits"      INTEGER     NOT NULL DEFAULT 0,
  "rejectedAudits"      INTEGER     NOT NULL DEFAULT 0,
  "badgeTier"           TEXT,
  "specializations"     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "isActive"            BOOLEAN     NOT NULL DEFAULT true,
  "suspendedAt"         TIMESTAMP(3),
  "suspendReason"       TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuditorRegistry_isVerified_idx"   ON "AuditorRegistry"("isVerified");
CREATE INDEX "AuditorRegistry_trustScore_idx"   ON "AuditorRegistry"("trustScore" DESC);
CREATE INDEX "AuditorRegistry_slug_idx"         ON "AuditorRegistry"("slug");

-- ── ExternalAudit schema additions ───────────────────────────────────────────
ALTER TABLE "ExternalAudit"
  ADD COLUMN IF NOT EXISTS "auditorId"         TEXT,
  ADD COLUMN IF NOT EXISTS "reportSignature"   TEXT,
  ADD COLUMN IF NOT EXISTS "summary"           TEXT,
  ADD COLUMN IF NOT EXISTS "rejectionReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "isPublic"          BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "ExternalAudit_auditorId_idx"
  ON "ExternalAudit"("auditorId");
