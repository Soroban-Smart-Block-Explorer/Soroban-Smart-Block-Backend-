-- Add remaining missing FK indexes identified by index audit (issues #502–#505)
-- Continues from 20260624000000_add_fk_indexes.

-- Developer.planId (FK to BillingPlan)
CREATE INDEX IF NOT EXISTS "Developer_planId_idx" ON "Developer"("planId");

-- GovernanceVote.proposalId (FK to GovernanceProposal; unique covers contractAddress+proposalId+voter
-- but does not serve standalone proposalId lookups needed for cascade deletes)
CREATE INDEX IF NOT EXISTS "GovernanceVote_proposalId_idx" ON "GovernanceVote"("proposalId");

-- PriceDeviation.poolIdA / poolIdB (FKs to DexPool)
CREATE INDEX IF NOT EXISTS "PriceDeviation_poolIdA_idx" ON "PriceDeviation"("poolIdA");
CREATE INDEX IF NOT EXISTS "PriceDeviation_poolIdB_idx" ON "PriceDeviation"("poolIdB");

-- Endorsement.profileId (FK to ReputationProfile)
CREATE INDEX IF NOT EXISTS "Endorsement_profileId_idx" ON "Endorsement"("profileId");

-- ReputationBadge.profileId (FK to ReputationProfile)
CREATE INDEX IF NOT EXISTS "ReputationBadge_profileId_idx" ON "ReputationBadge"("profileId");

-- ReputationSignal.profileId (FK to ReputationProfile)
CREATE INDEX IF NOT EXISTS "ReputationSignal_profileId_idx" ON "ReputationSignal"("profileId");

-- VerifiableCredential.profileId (FK to ReputationProfile)
CREATE INDEX IF NOT EXISTS "VerifiableCredential_profileId_idx" ON "VerifiableCredential"("profileId");

-- FuzzFinding.runId / fuzzRunId (join / lookup keys)
CREATE INDEX IF NOT EXISTS "FuzzFinding_runId_idx" ON "FuzzFinding"("runId");
CREATE INDEX IF NOT EXISTS "FuzzFinding_fuzzRunId_idx" ON "FuzzFinding"("fuzzRunId");

-- DataRetrieval.epochId (FK to ArchivalEpoch)
CREATE INDEX IF NOT EXISTS "data_retrievals_epochId_idx" ON "data_retrievals"("epochId");

-- ArchivalSlash.challengeId (FK to StorageChallenge)
CREATE INDEX IF NOT EXISTS "archival_slashes_challengeId_idx" ON "archival_slashes"("challengeId");

-- SavedQuery.queryId (FK to NlQuery)
CREATE INDEX IF NOT EXISTS "saved_queries_queryId_idx" ON "saved_queries"("query_id");
