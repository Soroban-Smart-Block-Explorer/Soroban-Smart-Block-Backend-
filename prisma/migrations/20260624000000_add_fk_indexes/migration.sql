-- Add missing FK indexes identified by index audit (issue #248)

-- Translation.keyId (FK to TranslationKey)
CREATE INDEX IF NOT EXISTS "Translation_keyId_idx" ON "Translation"("keyId");

-- AmmPool.poolAddress (primary lookup key)
CREATE INDEX IF NOT EXISTS "AmmPool_poolAddress_idx" ON "AmmPool"("poolAddress");

-- WasmUpgradeHistory.daoProposalId
CREATE INDEX IF NOT EXISTS "WasmUpgradeHistory_daoProposalId_idx" ON "WasmUpgradeHistory"("daoProposalId");

-- FailedItem.itemId
CREATE INDEX IF NOT EXISTS "FailedItem_itemId_idx" ON "FailedItem"("itemId");

-- FeedSubscription.userId
CREATE INDEX IF NOT EXISTS "FeedSubscription_userId_idx" ON "FeedSubscription"("userId");

-- IncidentReport.pauseEventId
CREATE INDEX IF NOT EXISTS "IncidentReport_pauseEventId_idx" ON "IncidentReport"("pauseEventId");

-- ContractComposability.contractId
CREATE INDEX IF NOT EXISTS "ContractComposability_contractId_idx" ON "ContractComposability"("contractId");

-- CompositionAlert.patternId
CREATE INDEX IF NOT EXISTS "CompositionAlert_patternId_idx" ON "CompositionAlert"("patternId");

-- GovernanceTimelock.proposalId
CREATE INDEX IF NOT EXISTS "GovernanceTimelock_proposalId_idx" ON "GovernanceTimelock"("proposalId");

-- ArbitrageOpportunity.buyPoolId, sellPoolId
CREATE INDEX IF NOT EXISTS "ArbitrageOpportunity_buyPoolId_idx" ON "ArbitrageOpportunity"("buyPoolId");
CREATE INDEX IF NOT EXISTS "ArbitrageOpportunity_sellPoolId_idx" ON "ArbitrageOpportunity"("sellPoolId");

-- Attestation.profileId, chainId
CREATE INDEX IF NOT EXISTS "Attestation_profileId_idx" ON "Attestation"("profileId");
CREATE INDEX IF NOT EXISTS "Attestation_chainId_idx" ON "Attestation"("chainId");

-- SandboxSession.userId
CREATE INDEX IF NOT EXISTS "SandboxSession_userId_idx" ON "SandboxSession"("userId");

-- SandboxCall.sessionId, contractId
CREATE INDEX IF NOT EXISTS "SandboxCall_sessionId_idx" ON "SandboxCall"("sessionId");
CREATE INDEX IF NOT EXISTS "SandboxCall_contractId_idx" ON "SandboxCall"("contractId");

-- WebhookDelivery.subscriptionId
CREATE INDEX IF NOT EXISTS "WebhookDelivery_subscriptionId_idx" ON "WebhookDelivery"("subscriptionId");

-- NftSale.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftSale_itemId_idx" ON "NftSale"("itemId");
CREATE INDEX IF NOT EXISTS "NftSale_tokenId_idx" ON "NftSale"("tokenId");

-- NftListing.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftListing_itemId_idx" ON "NftListing"("itemId");
CREATE INDEX IF NOT EXISTS "NftListing_tokenId_idx" ON "NftListing"("tokenId");

-- NftActivity.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftActivity_itemId_idx" ON "NftActivity"("itemId");
CREATE INDEX IF NOT EXISTS "NftActivity_tokenId_idx" ON "NftActivity"("tokenId");

-- BackfillRequest.userId
CREATE INDEX IF NOT EXISTS "BackfillRequest_userId_idx" ON "BackfillRequest"("userId");

-- DtccSettlementBridge.dtccSettlementId
CREATE INDEX IF NOT EXISTS "DtccSettlementBridge_dtccSettlementId_idx" ON "DtccSettlementBridge"("dtccSettlementId");

-- YieldHistorySnapshot.opportunityId
CREATE INDEX IF NOT EXISTS "YieldHistorySnapshot_opportunityId_idx" ON "YieldHistorySnapshot"("opportunityId");
