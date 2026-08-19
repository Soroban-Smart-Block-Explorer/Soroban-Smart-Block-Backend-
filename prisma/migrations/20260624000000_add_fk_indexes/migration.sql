-- Add missing FK indexes identified by index audit (issue #248)
--
-- NOTE: Only tables that exist at this point in the migration chain are
-- indexed here. Indexes for tables created in later migrations (or never
-- materialized) were originally included but referenced non-existent tables
-- (e.g. "AmmPool", "WebhookDelivery", "SandboxSession"), which made every
-- fresh `prisma migrate deploy` fail with P3009.

-- Translation.keyId (FK to TranslationKey)
CREATE INDEX IF NOT EXISTS "Translation_keyId_idx" ON "Translation"("keyId");

-- ContractComposability.contractId
CREATE INDEX IF NOT EXISTS "ContractComposability_contractId_idx" ON "ContractComposability"("contractId");

-- CompositionAlert.patternId
CREATE INDEX IF NOT EXISTS "CompositionAlert_patternId_idx" ON "CompositionAlert"("patternId");

-- NftSale.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftSale_itemId_idx" ON "NftSale"("itemId");
CREATE INDEX IF NOT EXISTS "NftSale_tokenId_idx" ON "NftSale"("tokenId");

-- NftListing.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftListing_itemId_idx" ON "NftListing"("itemId");
CREATE INDEX IF NOT EXISTS "NftListing_tokenId_idx" ON "NftListing"("tokenId");

-- NftActivity.itemId, tokenId
CREATE INDEX IF NOT EXISTS "NftActivity_itemId_idx" ON "NftActivity"("itemId");
CREATE INDEX IF NOT EXISTS "NftActivity_tokenId_idx" ON "NftActivity"("tokenId");
