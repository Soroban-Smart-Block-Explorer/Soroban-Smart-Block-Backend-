-- Arbitrage Intelligence Platform Migration

-- CreateTable: dex_pools
CREATE TABLE "dex_pools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contract_address" VARCHAR(56) NOT NULL,
    "dex_name" VARCHAR(100) NOT NULL,
    "pool_type" VARCHAR(30) NOT NULL,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "token_a_symbol" VARCHAR(20),
    "token_b_symbol" VARCHAR(20),
    "fee_tier" DECIMAL(5,4),
    "total_liquidity" DECIMAL(30,0),
    "volume_24h" DECIMAL(30,0),
    "fees_24h" DECIMAL(30,0),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "dex_pools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dex_pools_contract_address_key" ON "dex_pools"("contract_address");
CREATE INDEX "dex_pools_dex_name_idx" ON "dex_pools"("dex_name");
CREATE INDEX "dex_pools_token_a_token_b_idx" ON "dex_pools"("token_a", "token_b");
CREATE INDEX "dex_pools_is_active_idx" ON "dex_pools"("is_active");

-- CreateTable: pool_prices
CREATE TABLE "pool_prices" (
    "id" BIGSERIAL NOT NULL,
    "pool_id" UUID NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "reserve_a" DECIMAL(30,0) NOT NULL,
    "reserve_b" DECIMAL(30,0) NOT NULL,
    "spot_price" DECIMAL(30,18) NOT NULL,
    "twap_1m" DECIMAL(30,18),
    "twap_5m" DECIMAL(30,18),
    "twap_1h" DECIMAL(30,18),
    "vwap" DECIMAL(30,18),
    "tick" INTEGER,
    "sqrt_price" DECIMAL(40,0),
    CONSTRAINT "pool_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pool_prices_pool_id_block_number_key" ON "pool_prices"("pool_id", "block_number");
CREATE INDEX "pool_prices_pool_id_timestamp_idx" ON "pool_prices"("pool_id", "timestamp" DESC);
CREATE INDEX "pool_prices_timestamp_idx" ON "pool_prices"("timestamp");

-- CreateTable: price_deviations
CREATE TABLE "price_deviations" (
    "id" BIGSERIAL NOT NULL,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "pool_id_a" UUID NOT NULL,
    "pool_id_b" UUID NOT NULL,
    "price_a" DECIMAL(30,18) NOT NULL,
    "price_b" DECIMAL(30,18) NOT NULL,
    "deviation_percentage" DECIMAL(10,4) NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "block_number" BIGINT NOT NULL,
    CONSTRAINT "price_deviations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "price_deviations_token_a_token_b_timestamp_idx" ON "price_deviations"("token_a", "token_b", "timestamp" DESC);
CREATE INDEX "price_deviations_deviation_pct_idx" ON "price_deviations"("deviation_percentage" DESC);
CREATE INDEX "price_deviations_timestamp_idx" ON "price_deviations"("timestamp");

-- CreateTable: arbitrage_opportunities
CREATE TABLE "arbitrage_opportunities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pair" VARCHAR(50) NOT NULL,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "buy_pool_id" UUID,
    "sell_pool_id" UUID,
    "buy_price" DECIMAL(30,18) NOT NULL,
    "sell_price" DECIMAL(30,18) NOT NULL,
    "profit_percentage" DECIMAL(10,4) NOT NULL,
    "profit_estimate" DECIMAL(30,0),
    "capital_required" DECIMAL(30,0),
    "confidence" DECIMAL(5,4),
    "route" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "detected_at" TIMESTAMPTZ NOT NULL,
    "expired_at" TIMESTAMPTZ,
    "executed_at" TIMESTAMPTZ,
    "execution_tx_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "arbitrage_opportunities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "arb_opp_status_detected_idx" ON "arbitrage_opportunities"("status", "detected_at" DESC);
CREATE INDEX "arb_opp_pair_status_idx" ON "arbitrage_opportunities"("pair", "status");
CREATE INDEX "arb_opp_type_idx" ON "arbitrage_opportunities"("type");
CREATE INDEX "arb_opp_profit_pct_idx" ON "arbitrage_opportunities"("profit_percentage" DESC);
CREATE INDEX "arb_opp_detected_at_idx" ON "arbitrage_opportunities"("detected_at" DESC);

-- CreateTable: mev_opportunity_scores
CREATE TABLE "mev_opportunity_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opportunity_id" UUID NOT NULL,
    "profitability_score" DECIMAL(5,2),
    "capital_efficiency" DECIMAL(10,4),
    "speed_requirement" VARCHAR(20),
    "competition_level" VARCHAR(20),
    "slippage_risk" DECIMAL(5,2),
    "frontrunning_risk" DECIMAL(5,2),
    "overall_score" DECIMAL(5,2),
    "recommendation" VARCHAR(50),
    "scored_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "mev_opportunity_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mev_opportunity_scores_opportunity_id_key" ON "mev_opportunity_scores"("opportunity_id");
CREATE INDEX "mev_opportunity_scores_overall_score_idx" ON "mev_opportunity_scores"("overall_score" DESC);
CREATE INDEX "mev_opportunity_scores_recommendation_idx" ON "mev_opportunity_scores"("recommendation");

-- CreateTable: arbitrage_executions
CREATE TABLE "arbitrage_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "opportunity_id" UUID NOT NULL,
    "searcher_address" VARCHAR(56),
    "tx_hash" VARCHAR(64) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "capital_used" DECIMAL(30,0),
    "gross_profit" DECIMAL(30,0),
    "gas_cost" DECIMAL(30,0),
    "net_profit" DECIMAL(30,0),
    "execution_time_ms" INTEGER,
    "success" BOOLEAN NOT NULL,
    "failure_reason" TEXT,
    "simulation_results" JSONB,
    "executed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "arbitrage_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "arbitrage_executions_opportunity_id_idx" ON "arbitrage_executions"("opportunity_id");
CREATE INDEX "arbitrage_executions_searcher_address_idx" ON "arbitrage_executions"("searcher_address");
CREATE INDEX "arbitrage_executions_success_idx" ON "arbitrage_executions"("success");
CREATE INDEX "arbitrage_executions_executed_at_idx" ON "arbitrage_executions"("executed_at" DESC);

-- CreateTable: arbitrage_bots
CREATE TABLE "arbitrage_bots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "address" VARCHAR(56) NOT NULL,
    "first_seen" TIMESTAMPTZ NOT NULL,
    "last_seen" TIMESTAMPTZ NOT NULL,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "successful_trades" INTEGER NOT NULL DEFAULT 0,
    "failed_trades" INTEGER NOT NULL DEFAULT 0,
    "total_profit" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "total_gas_spent" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "avg_profit_per_trade" DECIMAL(30,0),
    "success_rate" DECIMAL(5,4),
    "preferred_pairs" TEXT[] NOT NULL DEFAULT '{}',
    "preferred_dexs" TEXT[] NOT NULL DEFAULT '{}',
    "avg_capital_per_trade" DECIMAL(30,0),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "arbitrage_bots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "arbitrage_bots_address_key" ON "arbitrage_bots"("address");
CREATE INDEX "arbitrage_bots_total_profit_idx" ON "arbitrage_bots"("total_profit" DESC);
CREATE INDEX "arbitrage_bots_is_active_idx" ON "arbitrage_bots"("is_active");
CREATE INDEX "arbitrage_bots_last_seen_idx" ON "arbitrage_bots"("last_seen" DESC);

-- CreateTable: sandwich_attacks
CREATE TABLE "sandwich_attacks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pair" VARCHAR(50) NOT NULL,
    "dex" VARCHAR(100) NOT NULL,
    "victim_tx" VARCHAR(64) NOT NULL,
    "victim_address" VARCHAR(56) NOT NULL,
    "victim_slippage" DECIMAL(10,4) NOT NULL,
    "victim_loss" DECIMAL(30,0),
    "attacker_address" VARCHAR(56) NOT NULL,
    "attacker_profit" DECIMAL(30,0),
    "front_run_tx" VARCHAR(64) NOT NULL,
    "back_run_tx" VARCHAR(64) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "sandwich_attacks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sandwich_attacks_victim_address_idx" ON "sandwich_attacks"("victim_address");
CREATE INDEX "sandwich_attacks_attacker_address_idx" ON "sandwich_attacks"("attacker_address");
CREATE INDEX "sandwich_attacks_timestamp_idx" ON "sandwich_attacks"("timestamp" DESC);
CREATE INDEX "sandwich_attacks_pair_idx" ON "sandwich_attacks"("pair");

-- CreateTable: arbitrage_alerts
CREATE TABLE "arbitrage_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "arbitrage_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "arbitrage_alerts_is_active_idx" ON "arbitrage_alerts"("is_active");

-- AddForeignKey constraints
ALTER TABLE "pool_prices" ADD CONSTRAINT "pool_prices_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_deviations" ADD CONSTRAINT "price_deviations_pool_id_a_fkey" FOREIGN KEY ("pool_id_a") REFERENCES "dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_deviations" ADD CONSTRAINT "price_deviations_pool_id_b_fkey" FOREIGN KEY ("pool_id_b") REFERENCES "dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arbitrage_opportunities" ADD CONSTRAINT "arb_opp_buy_pool_id_fkey" FOREIGN KEY ("buy_pool_id") REFERENCES "dex_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "arbitrage_opportunities" ADD CONSTRAINT "arb_opp_sell_pool_id_fkey" FOREIGN KEY ("sell_pool_id") REFERENCES "dex_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mev_opportunity_scores" ADD CONSTRAINT "mev_scores_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "arbitrage_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arbitrage_executions" ADD CONSTRAINT "arb_exec_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "arbitrage_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
