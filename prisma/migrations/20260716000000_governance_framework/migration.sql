-- Governance & DAO Framework (issue #567) — Phase 1 schema rework.
-- Hand-edited from `prisma migrate diff` to preserve existing data:
--   * numeric columns move to i128-safe integer strings via explicit USING casts
--   * GovernanceVote.support Boolean -> String ('for'/'against')
--   * GovernanceVote FK is repointed from GovernanceProposal.id (cuid — broken:
--     the indexer writes on-chain proposal ids) to the composite natural key
--     (contractAddress, proposalId); orphaned rows are backfilled or removed first

-- ── Drop the broken FK up front ───────────────────────────────────────────────
ALTER TABLE "GovernanceVote" DROP CONSTRAINT IF EXISTS "GovernanceVote_proposalId_fkey";

-- ── GovernanceContract: typed config columns, drop dead Json blob ─────────────
ALTER TABLE "GovernanceContract" DROP COLUMN "proposals",
ADD COLUMN     "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "convictionHalfLifeLedgers" INTEGER,
ADD COLUMN     "convictionMaxRatioBps" INTEGER,
ADD COLUMN     "guardian" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "minReputationScore" DOUBLE PRECISION,
ADD COLUMN     "minTokenHolding" TEXT,
ADD COLUMN     "multisigThreshold" INTEGER,
ADD COLUMN     "proposalThreshold" TEXT,
ADD COLUMN     "quorumBps" INTEGER,
ADD COLUMN     "timelockDelaySecs" INTEGER,
ADD COLUMN     "voiceCreditsPerRound" INTEGER,
ADD COLUMN     "votingPeriodLedgers" INTEGER;

-- ── GovernanceDelegate: Float votes -> integer string, String[] -> count ──────
ALTER TABLE "GovernanceDelegate"
  ALTER COLUMN "delegatedVotes" SET DATA TYPE TEXT
    USING CASE WHEN "delegatedVotes" IS NULL THEN NULL
               ELSE round("delegatedVotes"::numeric)::text END;
ALTER TABLE "GovernanceDelegate"
  DROP COLUMN "delegators",
  ADD COLUMN "delegators" INTEGER;

-- ── GovernanceProposal: new lifecycle/payload columns, numeric -> string ──────
ALTER TABLE "GovernanceProposal" DROP COLUMN "votes",
ADD COLUMN     "calldatas" JSONB,
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "eta" TIMESTAMP(3),
ADD COLUMN     "executionKind" TEXT,
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "snapshotLedger" INTEGER,
ADD COLUMN     "template" TEXT,
ADD COLUMN     "values" JSONB,
ADD COLUMN     "votingModel" TEXT,
ALTER COLUMN "quorum" SET DATA TYPE TEXT USING "quorum"::text,
ALTER COLUMN "votesFor" SET DATA TYPE TEXT
  USING CASE WHEN "votesFor" IS NULL THEN NULL ELSE round("votesFor"::numeric)::text END,
ALTER COLUMN "votesAgainst" SET DATA TYPE TEXT
  USING CASE WHEN "votesAgainst" IS NULL THEN NULL ELSE round("votesAgainst"::numeric)::text END,
ALTER COLUMN "votesAbstain" SET DATA TYPE TEXT
  USING CASE WHEN "votesAbstain" IS NULL THEN NULL ELSE round("votesAbstain"::numeric)::text END;

-- ── GovernanceVote: support Boolean -> String, weight -> string, new columns ──
ALTER TABLE "GovernanceVote"
ADD COLUMN     "convictionAt" TEXT,
ADD COLUMN     "lastUpdateLedger" INTEGER,
ADD COLUMN     "stakeAmount" TEXT,
ADD COLUMN     "voiceCredits" INTEGER,
ALTER COLUMN "weight" SET DATA TYPE TEXT
  USING CASE WHEN "weight" IS NULL THEN NULL ELSE round("weight"::numeric)::text END,
ALTER COLUMN "support" SET DATA TYPE TEXT
  USING CASE WHEN "support" IS NULL THEN NULL
             WHEN "support" THEN 'for'
             ELSE 'against' END;

-- ── Backfill parents so the new FKs hold ──────────────────────────────────────
-- Contracts referenced by proposals/votes/delegates but never registered.
INSERT INTO "GovernanceContract" ("id", "contractAddress", "governanceType", "updatedAt", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text), src."contractAddress", 'token_based', NOW(), NOW()
FROM (
  SELECT "contractAddress" FROM "GovernanceProposal"
  UNION SELECT "contractAddress" FROM "GovernanceVote"
  UNION SELECT "contractAddress" FROM "GovernanceDelegate"
) src
WHERE NOT EXISTS (
  SELECT 1 FROM "GovernanceContract" gc WHERE gc."contractAddress" = src."contractAddress"
);

-- Votes written under the old (broken) cuid FK: remap proposalId from the
-- proposal's cuid to its on-chain proposalId where possible, then drop
-- anything still unmatched (unwritable rows from the broken-FK era).
UPDATE "GovernanceVote" v
SET "proposalId" = p."proposalId"
FROM "GovernanceProposal" p
WHERE v."proposalId" = p."id" AND v."contractAddress" = p."contractAddress";

DELETE FROM "GovernanceVote" v
WHERE NOT EXISTS (
  SELECT 1 FROM "GovernanceProposal" p
  WHERE p."contractAddress" = v."contractAddress" AND p."proposalId" = v."proposalId"
);

-- ── New tables ────────────────────────────────────────────────────────────────
CREATE TABLE "GovernanceDelegation" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "delegator" TEXT NOT NULL,
    "delegatee" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'all',
    "transactionHash" TEXT,
    "ledgerSequence" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceDelegation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GovernanceVoiceCredit" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "budget" INTEGER NOT NULL,
    "spent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceVoiceCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GovernanceMultisigSigner" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "transactionHash" TEXT,

    CONSTRAINT "GovernanceMultisigSigner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TreasuryAccount" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "name" TEXT,
    "reputationWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TreasuryAsset" (
    "id" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "balance" TEXT NOT NULL DEFAULT '0',
    "decimals" INTEGER NOT NULL DEFAULT 7,
    "valueUsd" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TreasuryPayoutStream" (
    "id" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "amountPerPeriod" TEXT NOT NULL,
    "periodSeconds" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "claimed" TEXT NOT NULL DEFAULT '0',
    "proposalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryPayoutStream_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TreasuryTransaction" (
    "id" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "tokenAddress" TEXT,
    "amount" TEXT NOT NULL,
    "counterparty" TEXT,
    "category" TEXT,
    "transactionHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryTransaction_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX "GovernanceDelegation_contractAddress_delegator_idx" ON "GovernanceDelegation"("contractAddress", "delegator");
CREATE INDEX "GovernanceDelegation_contractAddress_delegatee_idx" ON "GovernanceDelegation"("contractAddress", "delegatee");
CREATE INDEX "GovernanceDelegation_revokedAt_idx" ON "GovernanceDelegation"("revokedAt");
CREATE INDEX "GovernanceVoiceCredit_contractAddress_holder_idx" ON "GovernanceVoiceCredit"("contractAddress", "holder");
CREATE UNIQUE INDEX "GovernanceVoiceCredit_contractAddress_round_holder_key" ON "GovernanceVoiceCredit"("contractAddress", "round", "holder");
CREATE INDEX "GovernanceMultisigSigner_contractAddress_removedAt_idx" ON "GovernanceMultisigSigner"("contractAddress", "removedAt");
CREATE UNIQUE INDEX "GovernanceMultisigSigner_contractAddress_signer_key" ON "GovernanceMultisigSigner"("contractAddress", "signer");
CREATE UNIQUE INDEX "TreasuryAccount_accountAddress_key" ON "TreasuryAccount"("accountAddress");
CREATE INDEX "TreasuryAccount_contractAddress_idx" ON "TreasuryAccount"("contractAddress");
CREATE INDEX "TreasuryAsset_treasuryId_idx" ON "TreasuryAsset"("treasuryId");
CREATE UNIQUE INDEX "TreasuryAsset_treasuryId_assetCode_tokenAddress_key" ON "TreasuryAsset"("treasuryId", "assetCode", "tokenAddress");
CREATE INDEX "TreasuryPayoutStream_treasuryId_idx" ON "TreasuryPayoutStream"("treasuryId");
CREATE INDEX "TreasuryPayoutStream_recipient_idx" ON "TreasuryPayoutStream"("recipient");
CREATE INDEX "TreasuryPayoutStream_proposalId_idx" ON "TreasuryPayoutStream"("proposalId");
CREATE INDEX "TreasuryTransaction_treasuryId_timestamp_idx" ON "TreasuryTransaction"("treasuryId", "timestamp");
CREATE INDEX "TreasuryTransaction_transactionHash_idx" ON "TreasuryTransaction"("transactionHash");
CREATE UNIQUE INDEX "TreasuryTransaction_treasuryId_transactionHash_assetCode_di_key" ON "TreasuryTransaction"("treasuryId", "transactionHash", "assetCode", "direction");
CREATE INDEX "GovernanceTimelock_proposalId_idx" ON "GovernanceTimelock"("proposalId");
CREATE INDEX "GovernanceProposal_status_idx" ON "GovernanceProposal"("status");
CREATE INDEX "GovernanceProposal_proposer_idx" ON "GovernanceProposal"("proposer");
CREATE INDEX "GovernanceVote_voter_idx" ON "GovernanceVote"("voter");

-- ── Foreign keys ──────────────────────────────────────────────────────────────
ALTER TABLE "GovernanceDelegate" ADD CONSTRAINT "GovernanceDelegate_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceDelegation" ADD CONSTRAINT "GovernanceDelegation_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceMultisigSigner" ADD CONSTRAINT "GovernanceMultisigSigner_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceProposal" ADD CONSTRAINT "GovernanceProposal_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceVote" ADD CONSTRAINT "GovernanceVote_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GovernanceVote" ADD CONSTRAINT "GovernanceVote_contractAddress_proposalId_fkey" FOREIGN KEY ("contractAddress", "proposalId") REFERENCES "GovernanceProposal"("contractAddress", "proposalId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TreasuryAccount" ADD CONSTRAINT "TreasuryAccount_contractAddress_fkey" FOREIGN KEY ("contractAddress") REFERENCES "GovernanceContract"("contractAddress") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TreasuryAsset" ADD CONSTRAINT "TreasuryAsset_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "TreasuryAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TreasuryPayoutStream" ADD CONSTRAINT "TreasuryPayoutStream_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "TreasuryAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TreasuryTransaction" ADD CONSTRAINT "TreasuryTransaction_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "TreasuryAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
