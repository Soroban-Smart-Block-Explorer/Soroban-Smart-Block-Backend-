-- NFT Collection Discovery, Rarity Engine, Marketplace Analytics & Portfolio Tracker

CREATE TABLE "NftCollection" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "name" TEXT,
    "symbol" TEXT,
    "description" TEXT,
    "category" TEXT,
    "totalSupply" INTEGER NOT NULL DEFAULT 0,
    "uniqueHolders" INTEGER NOT NULL DEFAULT 0,
    "floorPrice" DECIMAL(65,30),
    "floorPriceToken" TEXT,
    "floorPriceUsd" DECIMAL(65,30),
    "totalVolume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume7d" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume30d" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "avgPrice24h" DECIMAL(65,30),
    "avgPrice7d" DECIMAL(65,30),
    "marketCap" DECIMAL(65,30),
    "mintPrice" DECIMAL(65,30),
    "mintStart" TIMESTAMP(3),
    "mintEnd" TIMESTAMP(3),
    "royaltyPct" DOUBLE PRECISION,
    "royaltyRecipient" TEXT,
    "website" TEXT,
    "discord" TEXT,
    "twitter" TEXT,
    "logoUri" TEXT,
    "bannerUri" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isSpam" BOOLEAN NOT NULL DEFAULT false,
    "isMintable" BOOLEAN NOT NULL DEFAULT false,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSaleAt" TIMESTAMP(3),
    CONSTRAINT "NftCollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftCollection_contractAddress_key" ON "NftCollection"("contractAddress");
CREATE INDEX "NftCollection_volume24h_idx" ON "NftCollection"("volume24h" DESC);
CREATE INDEX "NftCollection_volume7d_idx" ON "NftCollection"("volume7d" DESC);
CREATE INDEX "NftCollection_uniqueHolders_idx" ON "NftCollection"("uniqueHolders" DESC);
CREATE INDEX "NftCollection_marketCap_idx" ON "NftCollection"("marketCap" DESC);
CREATE INDEX "NftCollection_floorPrice_idx" ON "NftCollection"("floorPrice" DESC);
CREATE INDEX "NftCollection_category_idx" ON "NftCollection"("category");

CREATE TABLE "NftItem" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "mintedAt" TIMESTAMP(3) NOT NULL,
    "mintTxHash" TEXT NOT NULL,
    "mintPrice" DECIMAL(65,30),
    "lastSalePrice" DECIMAL(65,30),
    "lastSalePriceUsd" DECIMAL(65,30),
    "lastSaleAt" TIMESTAMP(3),
    "saleCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "metadataUri" TEXT,
    "metadataFetchedAt" TIMESTAMP(3),
    "rarityScore" DOUBLE PRECISION,
    "rarityRank" INTEGER,
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "listingPrice" DECIMAL(65,30),
    "listingMarket" TEXT,
    "isSoulbound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NftItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftItem_collectionId_tokenId_key" ON "NftItem"("collectionId", "tokenId");
CREATE INDEX "NftItem_owner_idx" ON "NftItem"("owner");
CREATE INDEX "NftItem_rarityScore_idx" ON "NftItem"("rarityScore" DESC);
CREATE INDEX "NftItem_lastSaleAt_idx" ON "NftItem"("lastSaleAt" DESC);
CREATE INDEX "NftItem_collectionId_idx" ON "NftItem"("collectionId");

CREATE TABLE "NftTrait" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "traitType" TEXT NOT NULL,
    "traitValue" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "rarityScore" DOUBLE PRECISION,
    "rarityTier" TEXT,
    CONSTRAINT "NftTrait_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftTrait_collectionId_traitType_traitValue_key" ON "NftTrait"("collectionId", "traitType", "traitValue");
CREATE INDEX "NftTrait_collectionId_idx" ON "NftTrait"("collectionId");

CREATE TABLE "NftSale" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT,
    "tokenId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "priceUsd" DECIMAL(65,30),
    "priceToken" TEXT,
    "txHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER,
    "marketplace" TEXT,
    "saleType" TEXT NOT NULL,
    "saleAt" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isWashTrade" BOOLEAN NOT NULL DEFAULT false,
    "washTradeScore" DOUBLE PRECISION,
    CONSTRAINT "NftSale_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftSale_txHash_key" ON "NftSale"("txHash");
CREATE INDEX "NftSale_collectionId_saleAt_idx" ON "NftSale"("collectionId", "saleAt");
CREATE INDEX "NftSale_seller_idx" ON "NftSale"("seller");
CREATE INDEX "NftSale_buyer_idx" ON "NftSale"("buyer");
CREATE INDEX "NftSale_isWashTrade_idx" ON "NftSale"("isWashTrade");

CREATE TABLE "NftListing" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "priceUsd" DECIMAL(65,30),
    "priceToken" TEXT,
    "marketplace" TEXT,
    "listedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "NftListing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NftListing_collectionId_status_idx" ON "NftListing"("collectionId", "status");
CREATE INDEX "NftListing_seller_idx" ON "NftListing"("seller");

CREATE TABLE "NftCollectionStats" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "floorPrice" DECIMAL(65,30),
    "floorPriceUsd" DECIMAL(65,30),
    "totalVolume" DECIMAL(65,30) NOT NULL,
    "volume24h" DECIMAL(65,30) NOT NULL,
    "avgPrice24h" DECIMAL(65,30),
    "uniqueHolders" INTEGER NOT NULL,
    "totalSupply" INTEGER NOT NULL,
    "washVolume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "washTxCount24h" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "NftCollectionStats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftCollectionStats_collectionId_timestamp_key" ON "NftCollectionStats"("collectionId", "timestamp");
CREATE INDEX "NftCollectionStats_collectionId_timestamp_idx" ON "NftCollectionStats"("collectionId", "timestamp" DESC);

CREATE TABLE "NftPortfolio" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT,
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalValueUsd" DECIMAL(65,30),
    "totalPaidUsd" DECIMAL(65,30),
    "unrealizedPnlUsd" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NftPortfolio_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NftPortfolio_userId_idx" ON "NftPortfolio"("userId");
CREATE INDEX "NftPortfolio_owner_idx" ON "NftPortfolio"("owner");

CREATE TABLE "NftActivity" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT,
    "tokenId" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "price" DECIMAL(65,30),
    "priceUsd" DECIMAL(65,30),
    "txHash" TEXT NOT NULL,
    "ledgerSequence" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "NftActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NftActivity_collectionId_occurredAt_idx" ON "NftActivity"("collectionId", "occurredAt" DESC);
CREATE INDEX "NftActivity_activityType_occurredAt_idx" ON "NftActivity"("activityType", "occurredAt" DESC);
CREATE INDEX "NftActivity_txHash_idx" ON "NftActivity"("txHash");

CREATE TABLE "NftMarketplace" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "website" TEXT,
    "logoUri" TEXT,
    "totalVolume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalListings" INTEGER NOT NULL DEFAULT 0,
    "activeListings" INTEGER NOT NULL DEFAULT 0,
    "uniqueCollections" INTEGER NOT NULL DEFAULT 0,
    "activeTraders24h" INTEGER NOT NULL DEFAULT 0,
    "feePct" DOUBLE PRECISION,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NftMarketplace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftMarketplace_contractAddress_key" ON "NftMarketplace"("contractAddress");
CREATE INDEX "NftMarketplace_isActive_idx" ON "NftMarketplace"("isActive");
