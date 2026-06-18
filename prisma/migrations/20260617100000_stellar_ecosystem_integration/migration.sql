-- Stellar Ecosystem Integration: unified account view, anchors, assets, bridges

CREATE TABLE "stellar_accounts" (
    "id" UUID NOT NULL,
    "address" VARCHAR(56) NOT NULL,
    "xlm_balance" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "buying_liabilities" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "selling_liabilities" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "sequence_number" BIGINT,
    "subentry_count" INTEGER NOT NULL DEFAULT 0,
    "inflation_destination" VARCHAR(56),
    "home_domain" VARCHAR(255),
    "home_domain_verified" BOOLEAN NOT NULL DEFAULT false,
    "flags" JSONB,
    "thresholds" JSONB,
    "num_signers" INTEGER NOT NULL DEFAULT 0,
    "num_trustlines" INTEGER NOT NULL DEFAULT 0,
    "num_data_entries" INTEGER NOT NULL DEFAULT 0,
    "num_claimable_balances" INTEGER NOT NULL DEFAULT 0,
    "is_activated" BOOLEAN NOT NULL DEFAULT false,
    "first_seen" TIMESTAMPTZ,
    "last_activity" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "stellar_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stellar_accounts_address_key" ON "stellar_accounts"("address");

CREATE TABLE "account_trustlines" (
    "id" BIGSERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "asset_issuer" VARCHAR(56) NOT NULL,
    "balance" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "limit_amount" DECIMAL(30,7),
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "authorized_to_maintain_liabilities" BOOLEAN NOT NULL DEFAULT false,
    "clawback_balance_set" BOOLEAN NOT NULL DEFAULT false,
    "is_liquidity_pool_share" BOOLEAN NOT NULL DEFAULT false,
    "last_modified" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "account_trustlines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_trustlines_account_id_asset_code_asset_issuer_key"
    ON "account_trustlines"("account_id", "asset_code", "asset_issuer");

ALTER TABLE "account_trustlines"
    ADD CONSTRAINT "account_trustlines_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "stellar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "account_signers" (
    "id" BIGSERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "signer_key" VARCHAR(56) NOT NULL,
    "signer_type" VARCHAR(30) NOT NULL,
    "weight" INTEGER NOT NULL,
    "sponsor" VARCHAR(56),
    "last_modified" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "account_signers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_signers_account_id_signer_key_key"
    ON "account_signers"("account_id", "signer_key");

ALTER TABLE "account_signers"
    ADD CONSTRAINT "account_signers_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "stellar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stellar_assets" (
    "id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "asset_issuer" VARCHAR(56) NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "total_supply" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "num_holders" INTEGER NOT NULL DEFAULT 0,
    "num_trustlines" INTEGER NOT NULL DEFAULT 0,
    "volume_24h" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "trades_24h" INTEGER NOT NULL DEFAULT 0,
    "is_anchored" BOOLEAN NOT NULL DEFAULT false,
    "anchor_name" VARCHAR(255),
    "home_domain" VARCHAR(255),
    "is_bridged_to_soroban" BOOLEAN NOT NULL DEFAULT false,
    "soroban_contract" VARCHAR(56),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "stellar_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stellar_assets_asset_code_asset_issuer_key"
    ON "stellar_assets"("asset_code", "asset_issuer");

CREATE TABLE "unified_transactions" (
    "id" UUID NOT NULL,
    "source_account" VARCHAR(56) NOT NULL,
    "network" VARCHAR(20) NOT NULL,
    "tx_hash" VARCHAR(64) NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "sub_type" VARCHAR(50),
    "amount" DECIMAL(30,7),
    "asset_code" VARCHAR(12),
    "asset_issuer" VARCHAR(56),
    "destination" VARCHAR(56),
    "fee" DECIMAL(30,7),
    "memo_type" VARCHAR(20),
    "memo_content" TEXT,
    "successful" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "ledger_sequence" INTEGER,
    "operations" JSONB,
    CONSTRAINT "unified_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unified_transactions_network_tx_hash_key"
    ON "unified_transactions"("network", "tx_hash");

CREATE INDEX "unified_transactions_source_account_created_at_idx"
    ON "unified_transactions"("source_account", "created_at");

CREATE TABLE "anchors_registry" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "home_domain" VARCHAR(255) NOT NULL,
    "address" VARCHAR(56),
    "assets" JSONB NOT NULL,
    "regions" TEXT[],
    "kyc_required" BOOLEAN NOT NULL DEFAULT false,
    "kyc_types" TEXT[],
    "fees" JSONB,
    "limits" JSONB,
    "supported_seps" TEXT[],
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "anchors_registry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "anchors_registry_home_domain_idx" ON "anchors_registry"("home_domain");
CREATE INDEX "anchors_registry_status_idx" ON "anchors_registry"("status");

CREATE TABLE "anchor_reviews" (
    "id" UUID NOT NULL,
    "anchor_id" UUID NOT NULL,
    "reviewer" VARCHAR(56) NOT NULL,
    "rating" DECIMAL(3,2) NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "anchor_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "anchor_reviews_anchor_id_idx" ON "anchor_reviews"("anchor_id");

ALTER TABLE "anchor_reviews"
    ADD CONSTRAINT "anchor_reviews_anchor_id_fkey"
    FOREIGN KEY ("anchor_id") REFERENCES "anchors_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "bridged_assets" (
    "id" UUID NOT NULL,
    "classic_asset_code" VARCHAR(12) NOT NULL,
    "classic_asset_issuer" VARCHAR(56) NOT NULL,
    "soroban_contract" VARCHAR(56) NOT NULL,
    "bridge_protocol" VARCHAR(50) NOT NULL,
    "bridge_contract" VARCHAR(56),
    "total_supply_classic" DECIMAL(30,7),
    "total_supply_soroban" DECIMAL(30,7),
    "circulation_classic" DECIMAL(30,7),
    "circulation_soroban" DECIMAL(30,7),
    "locked_in_bridge" DECIMAL(30,7),
    "total_bridged_volume" DECIMAL(30,0),
    "bridge_fee" DECIMAL(5,4),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "bridged_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bridged_assets_soroban_contract_key" ON "bridged_assets"("soroban_contract");

CREATE TABLE "stellar_network_health" (
    "id" BIGSERIAL NOT NULL,
    "node_count" INTEGER,
    "organization_count" INTEGER,
    "countries_count" INTEGER,
    "consensus_round_time_ms" INTEGER,
    "ledger_close_time_ms" INTEGER,
    "latest_ledger_sequence" BIGINT,
    "protocol_version" INTEGER,
    "scp_messages_per_second" DECIMAL(10,2),
    "network_quorum_set" JSONB,
    "top_organizations" JSONB,
    "collected_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "stellar_network_health_pkey" PRIMARY KEY ("id")
);
