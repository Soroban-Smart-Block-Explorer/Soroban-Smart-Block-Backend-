-- Cross-Protocol Liquidity Aggregation Engine (Issue #334)
-- Core DEX Pool Indexing, Smart Order Router, Limit Orders, DCA, CL Positions, MEV Protection, Cross-Chain Bridges
-- Uses separate tables from the existing dex_pools (Prisma DexPool model)

-- CreateEnums (safe: IF NOT EXISTS pattern via DO block)
DO $$ BEGIN
    CREATE TYPE "PoolType" AS ENUM ('constant_product', 'concentrated', 'stable', 'weighted', 'dynamic_fee');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "OrderType" AS ENUM ('market', 'limit', 'stop_loss', 'take_profit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "OrderStatus" AS ENUM ('pending', 'filled', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "FillStrategy" AS ENUM ('fill_or_kill', 'immediate_or_cancel', 'good_till_time');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "DcaStatus" AS ENUM ('active', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "MevProtectionStrategy" AS ENUM ('private_mempool', 'batch_auction', 'commit_reveal', 'slippage_randomization', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "ClPositionStatus" AS ENUM ('active', 'out_of_range', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "RebalancingStatus" AS ENUM ('idle', 'in_progress', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Aggregator Pool Registry (separate from the existing DexPool model)
CREATE TABLE IF NOT EXISTS "aggregator_pools" (
    "id" TEXT NOT NULL,
    "dex_name" VARCHAR(100) NOT NULL,
    "pool_address" VARCHAR(56) NOT NULL,
    "pool_type" "PoolType" NOT NULL DEFAULT 'constant_product',
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "token_a_symbol" VARCHAR(20),
    "token_b_symbol" VARCHAR(20),
    "token_a_decimals" INTEGER NOT NULL DEFAULT 7,
    "token_b_decimals" INTEGER NOT NULL DEFAULT 7,
    "fee_tier" INTEGER NOT NULL DEFAULT 30,
    "tick_spacing" INTEGER,
    "reserve_a" NUMERIC(40, 0) NOT NULL DEFAULT 0,
    "reserve_b" NUMERIC(40, 0) NOT NULL DEFAULT 0,
    "sqrt_price" NUMERIC(80, 0),
    "liquidity" NUMERIC(80, 0),
    "volume_24h" NUMERIC(40, 0) DEFAULT 0,
    "fees_24h" NUMERIC(40, 0) DEFAULT 0,
    "last_updated" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aggregator_pools_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aggregator_pools_dex_name_pool_address_key" UNIQUE ("dex_name", "pool_address")
);

-- Pool Price History
CREATE TABLE IF NOT EXISTS "pool_price_history" (
    "id" BIGSERIAL NOT NULL,
    "pool_id" TEXT NOT NULL,
    "price" NUMERIC(40, 20) NOT NULL,
    "reserve_a" NUMERIC(40, 0) NOT NULL,
    "reserve_b" NUMERIC(40, 0) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pool_price_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pool_price_history_pool_id_block_number_key" UNIQUE ("pool_id", "block_number")
);

-- Token Prices (consolidated registry)
CREATE TABLE IF NOT EXISTS "token_prices" (
    "id" BIGSERIAL NOT NULL,
    "token_address" VARCHAR(56) NOT NULL,
    "usd_price" NUMERIC(40, 20),
    "btc_price" NUMERIC(40, 20),
    "eth_price" NUMERIC(40, 20),
    "price_source" VARCHAR(50),
    "confidence" NUMERIC(5, 4),
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "token_prices_token_address_price_source_key" UNIQUE ("token_address", "price_source")
);

-- Route Optimizations
CREATE TABLE IF NOT EXISTS "route_optimizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_in" VARCHAR(56) NOT NULL,
    "token_out" VARCHAR(56) NOT NULL,
    "amount_in" NUMERIC(40, 0) NOT NULL,
    "total_output" NUMERIC(40, 0) NOT NULL,
    "total_price_impact" NUMERIC(10, 6),
    "total_gas_estimate" NUMERIC(20, 0),
    "route_count" INTEGER NOT NULL,
    "optimization_time_ms" INTEGER NOT NULL,
    "algorithm" VARCHAR(50),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "route_optimizations_pkey" PRIMARY KEY ("id")
);

-- Route Splits
CREATE TABLE IF NOT EXISTS "route_splits" (
    "id" BIGSERIAL NOT NULL,
    "optimization_id" UUID NOT NULL,
    "route_index" INTEGER NOT NULL,
    "dex_name" VARCHAR(100) NOT NULL,
    "pool_address" VARCHAR(56) NOT NULL,
    "percentage" NUMERIC(5, 2) NOT NULL,
    "amount_in" NUMERIC(40, 0) NOT NULL,
    "amount_out" NUMERIC(40, 0) NOT NULL,
    "price_impact" NUMERIC(10, 6),
    "gas_estimate" NUMERIC(20, 0),
    "hops" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "route_splits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "route_splits_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "route_optimizations"("id")
);

-- Limit Orders
CREATE TABLE IF NOT EXISTS "limit_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_address" VARCHAR(56) NOT NULL,
    "token_in" VARCHAR(56) NOT NULL,
    "token_out" VARCHAR(56) NOT NULL,
    "amount_in" NUMERIC(40, 0) NOT NULL,
    "amount_out_min" NUMERIC(40, 0) NOT NULL,
    "price_limit" NUMERIC(40, 20) NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "fill_strategy" "FillStrategy",
    "fill_amount" NUMERIC(40, 0) DEFAULT 0,
    "fill_count" INTEGER DEFAULT 0,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "limit_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "limit_orders_user_address_idx" ON "limit_orders"("user_address");
CREATE INDEX IF NOT EXISTS "limit_orders_status_idx" ON "limit_orders"("status");

-- DCA Strategies
CREATE TABLE IF NOT EXISTS "dca_strategies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_address" VARCHAR(56) NOT NULL,
    "token_in" VARCHAR(56) NOT NULL,
    "token_out" VARCHAR(56) NOT NULL,
    "amount_per_interval" NUMERIC(40, 0) NOT NULL,
    "interval_hours" INTEGER NOT NULL,
    "total_intervals" INTEGER,
    "intervals_executed" INTEGER DEFAULT 0,
    "status" "DcaStatus" NOT NULL DEFAULT 'active',
    "next_execution" TIMESTAMPTZ NOT NULL,
    "total_spent" NUMERIC(40, 0) DEFAULT 0,
    "total_received" NUMERIC(40, 0) DEFAULT 0,
    "avg_price" NUMERIC(40, 20),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dca_strategies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dca_strategies_user_address_idx" ON "dca_strategies"("user_address");
CREATE INDEX IF NOT EXISTS "dca_strategies_status_idx" ON "dca_strategies"("status");

-- Concentrated Liquidity Positions
CREATE TABLE IF NOT EXISTS "cl_positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_address" VARCHAR(56) NOT NULL,
    "pool_id" TEXT,
    "tick_lower" INTEGER NOT NULL,
    "tick_upper" INTEGER NOT NULL,
    "liquidity" NUMERIC(80, 0) NOT NULL,
    "amount_a" NUMERIC(40, 0) NOT NULL,
    "amount_b" NUMERIC(40, 0) NOT NULL,
    "unclaimed_fees_a" NUMERIC(40, 0) DEFAULT 0,
    "unclaimed_fees_b" NUMERIC(40, 0) DEFAULT 0,
    "apr_estimate" NUMERIC(10, 6),
    "status" "ClPositionStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cl_positions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cl_positions_user_address_idx" ON "cl_positions"("user_address");
CREATE INDEX IF NOT EXISTS "cl_positions_status_idx" ON "cl_positions"("status");

-- MEV Protection Requests
CREATE TABLE IF NOT EXISTS "mev_protections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_address" VARCHAR(56) NOT NULL,
    "route_id" UUID,
    "strategy" "MevProtectionStrategy" NOT NULL DEFAULT 'none',
    "slippage_tolerance" NUMERIC(10, 6),
    "deadline_blocks" INTEGER,
    "private_mempool" BOOLEAN DEFAULT false,
    "batch_auction_id" VARCHAR(100),
    "commit_reveal_hash" VARCHAR(64),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mev_protections_pkey" PRIMARY KEY ("id")
);

-- Cross-Chain Bridge Registry
CREATE TABLE IF NOT EXISTS "cross_chain_bridges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bridge_name" VARCHAR(100) NOT NULL,
    "from_chain" VARCHAR(50) NOT NULL,
    "to_chain" VARCHAR(50) NOT NULL,
    "token_address" VARCHAR(56),
    "fee_percentage" NUMERIC(10, 6),
    "estimated_time_ms" INTEGER,
    "min_deposit" NUMERIC(40, 0),
    "max_deposit" NUMERIC(40, 0),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cross_chain_bridges_pkey" PRIMARY KEY ("id")
);

-- Risk Assessments
CREATE TABLE IF NOT EXISTS "risk_assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_address" VARCHAR(56) NOT NULL,
    "risk_score" NUMERIC(5, 2),
    "risk_label" VARCHAR(20),
    "blacklisted" BOOLEAN DEFAULT false,
    "max_position_size" NUMERIC(40, 0),
    "correlation_risk" NUMERIC(5, 4),
    "impermanent_loss_risk" NUMERIC(5, 4),
    "details" JSONB,
    "assessed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "risk_assessments_token_address_idx" ON "risk_assessments"("token_address");

-- Social Trading / Top Traders
CREATE TABLE IF NOT EXISTS "top_traders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "address" VARCHAR(56) NOT NULL,
    "total_profit" NUMERIC(40, 0) DEFAULT 0,
    "total_trades" INTEGER DEFAULT 0,
    "success_rate" NUMERIC(5, 4),
    "preferred_dexes" JSONB,
    "preferred_pairs" JSONB,
    "avg_slippage" NUMERIC(10, 6),
    "profit_7d" NUMERIC(40, 0) DEFAULT 0,
    "profit_30d" NUMERIC(40, 0) DEFAULT 0,
    "last_active" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "top_traders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "top_traders_address_key" UNIQUE ("address")
);

-- On-Chain TWAP Oracle
CREATE TABLE IF NOT EXISTS "twap_oracle_prices" (
    "id" BIGSERIAL NOT NULL,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "twap_price" NUMERIC(40, 20) NOT NULL,
    "window_seconds" INTEGER NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "twap_oracle_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "twap_oracle_prices_token_a_token_b_window_key" UNIQUE ("token_a", "token_b", "window_seconds", "block_number")
);

-- Copy Trading Relationships
CREATE TABLE IF NOT EXISTS "copy_traders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "follower_address" VARCHAR(56) NOT NULL,
    "trader_address" VARCHAR(56) NOT NULL,
    "allocation_percentage" NUMERIC(5, 2),
    "max_slippage" NUMERIC(10, 6),
    "active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "copy_traders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "copy_traders_follower_trader_key" UNIQUE ("follower_address", "trader_address")
);

-- Rebalancing Tasks
CREATE TABLE IF NOT EXISTS "rebalancing_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "position_id" UUID,
    "status" "RebalancingStatus" NOT NULL DEFAULT 'idle',
    "old_tick_lower" INTEGER,
    "old_tick_upper" INTEGER,
    "new_tick_lower" INTEGER,
    "new_tick_upper" INTEGER,
    "estimated_gas" NUMERIC(20, 0),
    "executed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rebalancing_tasks_pkey" PRIMARY KEY ("id")
);
