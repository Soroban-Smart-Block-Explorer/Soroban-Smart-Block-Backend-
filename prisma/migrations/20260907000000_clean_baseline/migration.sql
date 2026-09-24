-- CreateEnum
CREATE TYPE "ReentrancyType" AS ENUM ('SIMPLE', 'CROSS_CONTRACT', 'MULTI_STEP', 'READ_ONLY', 'CROSS_FUNCTION', 'DESTRUCTIVE');

-- CreateEnum
CREATE TYPE "ReentrancySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "QueryFeedback" AS ENUM ('helpful', 'not_helpful', 'incorrect', 'partial');

-- CreateEnum
CREATE TYPE "ArchivalNodeStatus" AS ENUM ('active', 'inactive', 'jailed', 'slashed');

-- CreateEnum
CREATE TYPE "EpochStatus" AS ENUM ('storing', 'stored', 'verifying', 'verified', 'failed', 'removed');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('pending', 'issued', 'responded', 'verified', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "RetrievalStatus" AS ENUM ('pending', 'routing', 'in_progress', 'completed', 'failed', 'refunded');

-- CreateTable
CREATE TABLE "_ledgers" (
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "previous_ledger_hash" TEXT,
    "close_time" TIMESTAMP(3) NOT NULL,
    "tx_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_ledgers_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "_wasm_upgrade_histories" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "previous_hash" TEXT,
    "new_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "transaction_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upgrader" TEXT,
    "upgrader_account_age_ledgers" INTEGER,
    "change_classification" TEXT,
    "change_summary" TEXT,
    "diff_stats" JSONB,
    "critical_fn_changes" TEXT[],
    "governance_type" TEXT,
    "signer_count" INTEGER,
    "threshold" INTEGER,
    "timelock_seconds" INTEGER,
    "dao_proposal_id" TEXT,
    "decentralization_score" INTEGER,
    "suspicious_flags" TEXT[],
    "is_suspicious" BOOLEAN NOT NULL DEFAULT false,
    "risk_level" TEXT,

    CONSTRAINT "_wasm_upgrade_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_transactions" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "source_account" TEXT NOT NULL,
    "contract_address" TEXT,
    "function_name" TEXT,
    "function_args" JSONB,
    "raw_xdr" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "flash_loan_alert" BOOLEAN,
    "human_readable" TEXT,
    "fee_charged" TEXT,
    "soroban_resources" JSONB,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_events" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "topic_symbol" TEXT,
    "topics" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "decoded" JSONB,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "compacted" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_event_definitions" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "topic_symbol" TEXT NOT NULL,
    "human_template" TEXT NOT NULL,
    "submitted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_event_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_certificates" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "overall_score" INTEGER NOT NULL,
    "security_score" INTEGER NOT NULL,
    "governance_score" INTEGER NOT NULL,
    "economic_score" INTEGER NOT NULL,
    "compliance_score" INTEGER NOT NULL,
    "liquidity_score" INTEGER NOT NULL,
    "signature_algorithm" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "certificate_hash" TEXT NOT NULL,
    "anchor_tx_hash" TEXT,
    "total_findings" INTEGER NOT NULL DEFAULT 0,
    "open_findings" INTEGER NOT NULL DEFAULT 0,
    "critical_findings" INTEGER NOT NULL DEFAULT 0,
    "high_findings" INTEGER NOT NULL DEFAULT 0,
    "medium_findings" INTEGER NOT NULL DEFAULT 0,
    "low_findings" INTEGER NOT NULL DEFAULT 0,
    "resolved_findings" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB NOT NULL,
    "scores" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_findings" (
    "id" TEXT NOT NULL,
    "certificate_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "detail" TEXT,
    "recommendation" TEXT,
    "status" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "cwe_id" TEXT,
    "cvss_vector" TEXT,
    "cvss_score" DOUBLE PRECISION,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_events" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "certificate_id" TEXT,
    "event_type" TEXT NOT NULL,
    "previous_score" INTEGER,
    "new_score" INTEGER,
    "trigger_source" TEXT NOT NULL,
    "details" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contracts" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "abi" JSONB,
    "function_signatures" JSONB,
    "is_token" BOOLEAN NOT NULL DEFAULT false,
    "token_symbol" TEXT,
    "token_name" TEXT,
    "token_decimals" INTEGER,
    "wasm_hash" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verification_badge" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "safety_score" INTEGER,
    "verified_properties" INTEGER NOT NULL DEFAULT 0,
    "total_properties" INTEGER NOT NULL DEFAULT 0,
    "vulnerabilities" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_verification_runs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "badge" TEXT,
    "safety_score" INTEGER,
    "report" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_verification_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_session_authorizations" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "hot_signer" TEXT,
    "authorization_type" TEXT NOT NULL,
    "start_ledger" INTEGER NOT NULL,
    "expiry_ledger" INTEGER NOT NULL,
    "allocated_blocks" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_session_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dex_pools" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL DEFAULT '',
    "chain" TEXT NOT NULL DEFAULT 'stellar',
    "protocol" TEXT NOT NULL DEFAULT '',
    "pool_type" TEXT NOT NULL DEFAULT 'constant_product',
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "dex_name" TEXT NOT NULL DEFAULT '',
    "contract_address" VARCHAR(56) NOT NULL DEFAULT '',
    "fee_tier" DECIMAL(10,6),
    "total_liquidity" DECIMAL(30,7),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_a" TEXT NOT NULL DEFAULT '',
    "token_a_symbol" TEXT NOT NULL DEFAULT '',
    "token_a_decimals" INTEGER NOT NULL DEFAULT 7,
    "reserve_a" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "token_b" TEXT NOT NULL DEFAULT '',
    "token_b_symbol" TEXT NOT NULL DEFAULT '',
    "token_b_decimals" INTEGER NOT NULL DEFAULT 7,
    "reserve_b" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "price_a_usd" DOUBLE PRECISION,
    "price_b_usd" DOUBLE PRECISION,
    "tvl_usd" DOUBLE PRECISION,
    "volume1h_usd" DOUBLE PRECISION,
    "volume24h_usd" DOUBLE PRECISION,
    "volume24h" DECIMAL(30,7),
    "volume7d_usd" DOUBLE PRECISION,
    "volume30d_usd" DOUBLE PRECISION,
    "fees24h_usd" DOUBLE PRECISION,
    "apr_pct" DOUBLE PRECISION,
    "il_risk_score" DOUBLE PRECISION,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_dex_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_vulnerability_advisories" (
    "id" TEXT NOT NULL,
    "advisory_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL,
    "affected_package" TEXT,
    "affected_contracts" TEXT[],
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_vulnerability_advisories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_propagation_analysis" (
    "id" TEXT NOT NULL,
    "advisory_id" TEXT NOT NULL,
    "vulnerable_contract" TEXT NOT NULL,
    "direct_affected" TEXT[],
    "affected_by_depth" JSONB NOT NULL,
    "total_value_at_risk" DECIMAL(65,30) DEFAULT 0,
    "analysis_depth" INTEGER NOT NULL DEFAULT 5,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_propagation_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_indexer_states" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "network" TEXT NOT NULL DEFAULT 'mainnet',
    "last_ledger" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "leader_id" TEXT,
    "leader_lease_expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_indexer_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_rate_limit_overrides" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT '/',
    "max" INTEGER NOT NULL DEFAULT 100,
    "window_ms" INTEGER NOT NULL DEFAULT 60000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_rate_limit_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reorg_events" (
    "id" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_hash" TEXT NOT NULL,
    "actual_hash" TEXT NOT NULL,
    "previous_hash" TEXT NOT NULL,
    "rolled_back_ledgers" INTEGER[],

    CONSTRAINT "_reorg_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ledger_gaps" (
    "id" TEXT NOT NULL,
    "start_sequence" INTEGER NOT NULL,
    "end_sequence" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),

    CONSTRAINT "_ledger_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_catch_up_checkpoints" (
    "id" TEXT NOT NULL,
    "range_start" INTEGER NOT NULL,
    "range_end" INTEGER NOT NULL,
    "last_committed_ledger" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_catch_up_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sac_mappings" (
    "id" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "asset_type" TEXT NOT NULL,
    "sac_address" TEXT NOT NULL,
    "first_seen_ledger" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sac_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sac_trustline_mappings" (
    "id" TEXT NOT NULL,
    "g_account" TEXT NOT NULL,
    "sac_address" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "asset_type" TEXT NOT NULL DEFAULT 'credit_alphanum4',
    "trustline_limit" TEXT NOT NULL DEFAULT '0',
    "is_unlimited" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "transaction_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "change_trust_op_ledger" INTEGER,
    "change_trust_op_tx_hash" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'soroban',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sac_trustline_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_verification_jobs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT,
    "toolchain" TEXT NOT NULL DEFAULT 'soroban-cli@0.9.4',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "uploaded_hash" TEXT,
    "on_chain_wasm_hash" TEXT,
    "compiled_wasm_hash" TEXT,
    "matched" BOOLEAN,
    "error_msg" TEXT,
    "logs" TEXT,
    "source_files" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_verification_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_states" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "ledger_key" TEXT NOT NULL,
    "key_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Live',
    "live_until_ledger_seq" INTEGER,
    "last_seen_ledger" INTEGER NOT NULL,
    "restored_at_ledger" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_contract_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_restoration_logs" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "fee_charged" TEXT,
    "restored_keys" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_restoration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_failed_items" (
    "id" TEXT NOT NULL,
    "item_type" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "raw_xdr" TEXT,
    "error_msg" TEXT NOT NULL,
    "error_stack" TEXT,
    "context" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "dead" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_tried_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_failed_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dead_letter_items" (
    "id" TEXT NOT NULL,
    "item_type" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "hash" TEXT,
    "error_msg" TEXT NOT NULL,
    "error_stack" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dead_letter_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_api_keies" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "_api_keies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_smart_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "wallet_type" TEXT NOT NULL,
    "signer_count" INTEGER,
    "threshold" INTEGER,
    "guardians" JSONB,
    "session_keys" JSONB,
    "auth_methods" JSONB,
    "deployed_at_ledger" INTEGER,
    "deployed_by_account" TEXT,
    "wasm_hash" TEXT,
    "first_seen_ledger" INTEGER NOT NULL,
    "last_seen_ledger" INTEGER NOT NULL,
    "tx_count" INTEGER NOT NULL DEFAULT 0,
    "sponsored_tx_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_smart_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sponsored_transactions" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "sponsor_account" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "wallet_address" TEXT,
    "fee_charged" TEXT,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sponsored_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_auth_decompositions" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "wallet_address" TEXT,
    "auth_tree" JSONB NOT NULL,
    "auth_methods" JSONB NOT NULL,
    "signer_count" INTEGER NOT NULL DEFAULT 0,
    "has_sub_calls" BOOLEAN NOT NULL DEFAULT false,
    "human_readable" TEXT,
    "ledger_sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_auth_decompositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sanctions_lists" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "list_version" TEXT NOT NULL,
    "list_name" TEXT,
    "entity_type" TEXT NOT NULL,
    "address" TEXT,
    "address_pattern" TEXT,
    "name" TEXT,
    "aliases" TEXT[],
    "program" TEXT,
    "country" TEXT,
    "id_document" TEXT,
    "citizenship" TEXT[],
    "birth_date" TEXT,
    "place_of_birth" TEXT,
    "title" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "added_to_list_at" TIMESTAMP(3) NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_modified_at" TIMESTAMP(3),

    CONSTRAINT "_sanctions_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_screening_results" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "tx_hash" TEXT,
    "screened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'clear',
    "match_type" TEXT,
    "matched_entries" JSONB,
    "screening_method" TEXT NOT NULL DEFAULT 'real_time',
    "reviewer_id" TEXT,
    "review_action" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "notes" TEXT,
    "duration_ms" INTEGER,

    CONSTRAINT "_screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_travel_rule_records" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "originator_vasp" TEXT,
    "beneficiary_vasp" TEXT,
    "originator_info" JSONB,
    "beneficiary_info" JSONB,
    "transfer_value" DECIMAL(30,7) NOT NULL,
    "threshold_exceeded" BOOLEAN NOT NULL DEFAULT false,
    "travel_rule_status" TEXT NOT NULL DEFAULT 'pending_verification',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),

    CONSTRAINT "_travel_rule_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_compliance_reports" (
    "id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "file_url" TEXT,
    "file_data" BYTEA,
    "parameters" JSONB,
    "report_data" JSONB,
    "created_by" TEXT,

    CONSTRAINT "_compliance_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_resource_metrics" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "memory_usage_bytes" INTEGER NOT NULL,
    "cpu_instructions" INTEGER NOT NULL,
    "storage_footprint" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_contract_resource_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_translation_keies" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "default_text" TEXT NOT NULL,
    "context" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_translation_keies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_translations" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "translated_text" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feed_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "schema" JSONB,
    "retention_days" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_feed_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feed_messages" (
    "id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3),
    "ledger_sequence" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_feed_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feed_subscriptions" (
    "id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "delivery_type" TEXT NOT NULL,
    "delivery_config" JSONB,
    "user_id" TEXT,
    "filters" JSONB,
    "batch_size" INTEGER,
    "max_rate_per_second" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_delivery_at" TIMESTAMP(3),
    "last_error" TEXT,
    "total_delivered" INTEGER,
    "total_failed" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_feed_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_emergency_states" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "current_pause_id" TEXT,
    "total_pause_count" INTEGER NOT NULL DEFAULT 0,
    "total_paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "last_pause_duration_seconds" BIGINT,
    "pauser_type" VARCHAR(30),
    "decentralization_score" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_emergency_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_pause_events" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "event_type" VARCHAR(20) NOT NULL,
    "pauser_address" VARCHAR(56),
    "reason" TEXT,
    "tx_hash" VARCHAR(64) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "duration_seconds" BIGINT,
    "gas_cost" BIGINT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_pause_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_pauser_analysis" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "pauser_type" VARCHAR(30) NOT NULL,
    "pauser_addresses" TEXT[],
    "unpauser_addresses" TEXT[],
    "threshold" INTEGER,
    "total_signers" INTEGER,
    "timelock_delay_seconds" BIGINT,
    "governance_contract" VARCHAR(56),
    "automatic_triggers" JSONB,
    "analysis_method" VARCHAR(30),
    "last_analyzed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_pauser_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_recovery_analysis" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "has_fund_recovery" BOOLEAN NOT NULL DEFAULT false,
    "fund_recovery_functions" TEXT[],
    "has_upgrade_capability" BOOLEAN NOT NULL DEFAULT false,
    "upgrade_functions" TEXT[],
    "has_migration_capability" BOOLEAN NOT NULL DEFAULT false,
    "migration_functions" TEXT[],
    "has_state_rollback" BOOLEAN NOT NULL DEFAULT false,
    "rollback_functions" TEXT[],
    "recovery_robustness_score" DECIMAL(5,2),
    "analysis_details" JSONB,
    "last_analyzed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_recovery_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_alert_configurations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "contract_address" VARCHAR(56),
    "name" VARCHAR(255),
    "alert_type" VARCHAR(50) NOT NULL,
    "conditions" JSONB,
    "channels" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_alert_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_incident_reports" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "pause_event_id" TEXT,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "timeline" JSONB,
    "affected_users_estimate" BIGINT,
    "affected_tvl_estimate" DECIMAL(30,0),
    "root_cause" TEXT,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_incident_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_incident_comments" (
    "id" TEXT NOT NULL,
    "incident_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_incident_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_health_scores" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "protocol_name" VARCHAR(255),
    "total_pauses30d" INTEGER NOT NULL DEFAULT 0,
    "total_pauses90d" INTEGER NOT NULL DEFAULT 0,
    "avg_pause_duration30d" BIGINT,
    "total_downtime30d" BIGINT,
    "last_pause_date" TIMESTAMP(3),
    "recovery_score" DECIMAL(5,2),
    "decentralization_score" DECIMAL(5,2),
    "health_score" DECIMAL(5,2),
    "risk_level" VARCHAR(20),
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_protocol_health_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_stellar_accounts" (
    "id" TEXT NOT NULL,
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
    "first_seen" TIMESTAMP(3),
    "last_activity" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_stellar_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_account_trustlines" (
    "id" BIGSERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "asset_issuer" VARCHAR(56) NOT NULL,
    "balance" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "limit_amount" DECIMAL(30,7),
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "authorized_to_maintain_liabilities" BOOLEAN NOT NULL DEFAULT false,
    "clawback_balance_set" BOOLEAN NOT NULL DEFAULT false,
    "is_liquidity_pool_share" BOOLEAN NOT NULL DEFAULT false,
    "last_modified" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_account_trustlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_account_signers" (
    "id" BIGSERIAL NOT NULL,
    "account_id" TEXT NOT NULL,
    "signer_key" VARCHAR(56) NOT NULL,
    "signer_type" VARCHAR(30) NOT NULL,
    "weight" INTEGER NOT NULL,
    "sponsor" VARCHAR(56),
    "last_modified" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_account_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_stellar_assets" (
    "id" TEXT NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "asset_issuer" VARCHAR(56) NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "total_supply" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "num_holders" INTEGER NOT NULL DEFAULT 0,
    "num_trustlines" INTEGER NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "trades24h" INTEGER NOT NULL DEFAULT 0,
    "is_anchored" BOOLEAN NOT NULL DEFAULT false,
    "anchor_name" VARCHAR(255),
    "home_domain" VARCHAR(255),
    "is_bridged_to_soroban" BOOLEAN NOT NULL DEFAULT false,
    "soroban_contract" VARCHAR(56),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_stellar_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_unified_transactions" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL,
    "ledger_sequence" INTEGER,
    "operations" JSONB,

    CONSTRAINT "_unified_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_anchors_registries" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_anchors_registries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_anchor_reviews" (
    "id" TEXT NOT NULL,
    "anchor_id" TEXT NOT NULL,
    "reviewer" VARCHAR(56) NOT NULL,
    "rating" DECIMAL(3,2) NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_anchor_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_bridged_assets" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_bridged_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_stellar_network_healths" (
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
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_stellar_network_healths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composed_transactions" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "ledger_seq" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "contract_calls" JSONB,
    "call_graph" JSONB,
    "safety_score" DOUBLE PRECISION,
    "risk_level" TEXT,
    "analysis_status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patterns" JSONB,

    CONSTRAINT "_composed_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composition_patterns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "risk_rating" TEXT NOT NULL DEFAULT 'medium_risk',
    "required_calls" INTEGER NOT NULL DEFAULT 2,
    "detection_rules" JSONB,
    "safe_if" JSONB,
    "mitigation_guide" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_composition_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composition_pattern_instances" (
    "id" TEXT NOT NULL,
    "tx_id" TEXT NOT NULL,
    "pattern_id" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_composition_pattern_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_composabilities" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "composed_with" JSONB,
    "composition_count" INTEGER NOT NULL DEFAULT 0,
    "unique_callers" INTEGER NOT NULL DEFAULT 0,
    "unique_callees" INTEGER NOT NULL DEFAULT 0,
    "avg_composition_depth" DOUBLE PRECISION,
    "safety_score_avg" DOUBLE PRECISION,
    "risk_incidents" INTEGER NOT NULL DEFAULT 0,
    "last_analyzed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_contract_composabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composition_alerts" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT,
    "contract_address" TEXT,
    "pattern_id" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "exploit_detected" BOOLEAN NOT NULL DEFAULT false,
    "mitigated" BOOLEAN NOT NULL DEFAULT false,
    "mitigation_patch" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "_composition_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composability_static_analysis" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "external_calls" JSONB,
    "call_graph" JSONB,
    "circular_deps" JSONB,
    "has_unbounded_recursion" BOOLEAN NOT NULL DEFAULT false,
    "max_call_depth" INTEGER NOT NULL DEFAULT 0,
    "analysis_version" TEXT NOT NULL DEFAULT '1.0',
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_composability_static_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composability_verifications" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "atomicity" BOOLEAN NOT NULL DEFAULT false,
    "authorization" BOOLEAN NOT NULL DEFAULT false,
    "state_consistency" BOOLEAN NOT NULL DEFAULT false,
    "reentrancy_free" BOOLEAN NOT NULL DEFAULT false,
    "oracle_freshness" BOOLEAN NOT NULL DEFAULT false,
    "atomicity_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "authorization_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "state_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reentrancy_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oracle_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "proof_data" JSONB,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_composability_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composability_fuzz_campaigns" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total_cases" INTEGER NOT NULL DEFAULT 0,
    "unsafe_found" INTEGER NOT NULL DEFAULT 0,
    "false_positives" INTEGER NOT NULL DEFAULT 0,
    "coverage_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "findings" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_composability_fuzz_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_composability_exploits" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pattern_category" TEXT NOT NULL,
    "cve_id" TEXT,
    "affected_contracts" TEXT[],
    "exploit_tx_hashes" TEXT[],
    "advisory_url" TEXT,
    "severity" TEXT NOT NULL,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_composability_exploits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ecosystem_composability_indexes" (
    "id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "composition_diversity" INTEGER NOT NULL DEFAULT 0,
    "avg_safety_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exploit_incident_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "protocol_interconnectivity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_contracts" INTEGER NOT NULL DEFAULT 0,
    "total_composed_tx" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_ecosystem_composability_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_mev_victims" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "total_loss_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "incident_count" INTEGER NOT NULL DEFAULT 0,
    "last_incident_at" TIMESTAMP(3),
    "first_incident_at" TIMESTAMP(3),
    "protection_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_mev_victims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_mev_attackers" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "total_profit_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attack_count" INTEGER NOT NULL DEFAULT 0,
    "favorite_type" TEXT,
    "last_attack_at" TIMESTAMP(3),
    "first_seen" TIMESTAMP(3),
    "is_contract" BOOLEAN NOT NULL DEFAULT false,
    "tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_mev_attackers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_mev_events" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "ledger_seq" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "mev_type" TEXT NOT NULL,
    "victim_address" TEXT,
    "attacker_address" TEXT,
    "protocol_address" TEXT,
    "token_in" TEXT,
    "token_out" TEXT,
    "amount_in" TEXT,
    "amount_out" TEXT,
    "profit_amount" TEXT,
    "profit_usd" DOUBLE PRECISION,
    "loss_amount" TEXT,
    "loss_usd" DOUBLE PRECISION,
    "tx_order" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "details" JSONB,
    "flash_loan_alert" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_mev_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_mev_resistances" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "contract_name" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "commit_reveal" BOOLEAN NOT NULL DEFAULT false,
    "batch_auctions" BOOLEAN NOT NULL DEFAULT false,
    "slippage_default" DOUBLE PRECISION,
    "private_mempool" BOOLEAN NOT NULL DEFAULT false,
    "encrypted_txs" BOOLEAN NOT NULL DEFAULT false,
    "mev_extracted_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_incidents" INTEGER NOT NULL DEFAULT 0,
    "last_incident_at" TIMESTAMP(3),
    "score_history" JSONB,
    "recommendations" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_protocol_mev_resistances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_mev_alerts" (
    "id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "tx_hash" TEXT,
    "victim_address" TEXT,
    "protocol_address" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "estimated_loss" DOUBLE PRECISION,
    "recommended_action" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "_mev_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_billing_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requests_per_day" INTEGER NOT NULL,
    "requests_per_month" INTEGER NOT NULL,
    "price_monthly" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_billing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_developers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "github_id" TEXT,
    "wallet_address" TEXT,
    "plan_id" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_developers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dev_api_keies" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "allowed_ips" JSONB,
    "allowed_domains" JSONB,
    "allowed_endpoints" JSONB,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "rate_limit_override" INTEGER,
    "revoked_at" TIMESTAMP(3),
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "rotated_from_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_dev_api_keies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_key_rotation_audits" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "old_key_id" TEXT NOT NULL,
    "new_key_id" TEXT NOT NULL,
    "reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "was_successful" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "metadata" JSONB,
    "rotated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_key_rotation_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dev_webhooks" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "retry_policy" JSONB,
    "headers" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "store_response_body" BOOLEAN NOT NULL DEFAULT true,
    "response_retention_days" INTEGER NOT NULL DEFAULT 90,
    "last_delivery_at" TIMESTAMP(3),
    "last_delivery_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_dev_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dev_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status_code" INTEGER,
    "response_body" TEXT,
    "duration_ms" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "delivered_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dev_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_usage_records" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "api_key_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_scheduled_operations" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "timer_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "description" TEXT,
    "trigger_time" TIMESTAMP(3) NOT NULL,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "interval_seconds" INTEGER,
    "recurrence_count" INTEGER,
    "events_executed" INTEGER NOT NULL DEFAULT 0,
    "parameters" JSONB,
    "source_tx" TEXT,
    "created_by" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "last_executed_at" TIMESTAMP(3),
    "next_trigger_at" TIMESTAMP(3),

    CONSTRAINT "_scheduled_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_vesting_schedules" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "beneficiary" TEXT NOT NULL,
    "total_amount" DECIMAL(65,30) NOT NULL,
    "cliff_date" TIMESTAMP(3),
    "cliff_amount" DECIMAL(65,30),
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "vesting_type" TEXT NOT NULL,
    "period_seconds" INTEGER,
    "amount_per_period" DECIMAL(65,30),
    "periods_total" INTEGER,
    "next_unlock_date" TIMESTAMP(3),
    "next_unlock_amount" DECIMAL(65,30),
    "total_unlocked" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_claimed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "source_tx" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_vesting_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_timelocks" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "proposal_id" TEXT,
    "title" TEXT,
    "description" TEXT,
    "proposer" TEXT NOT NULL,
    "executor" TEXT,
    "targets" JSONB NOT NULL,
    "values" JSONB NOT NULL,
    "calldatas" JSONB NOT NULL,
    "operation_hash" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL,
    "min_delay" INTEGER NOT NULL,
    "execution_time" TIMESTAMP(3) NOT NULL,
    "expiry_time" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "executed_tx" TEXT,
    "cancelled_by" TEXT,
    "grace_period" INTEGER,

    CONSTRAINT "_governance_timelocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_cron_jobs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "function_args" JSONB NOT NULL,
    "description" TEXT,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "successful_runs" INTEGER NOT NULL DEFAULT 0,
    "failed_runs" INTEGER NOT NULL DEFAULT 0,
    "max_runs" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_cron_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_cron_executions" (
    "id" TEXT NOT NULL,
    "cron_job_id" TEXT NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "tx_hash" TEXT,
    "error_message" TEXT,
    "gas_used" INTEGER,
    "duration" INTEGER,

    CONSTRAINT "_cron_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_timer_alerts" (
    "id" TEXT NOT NULL,
    "scheduled_op_id" TEXT,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "trigger_time" TIMESTAMP(3) NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "_timer_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_price_deviations" (
    "id" BIGSERIAL NOT NULL,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "pool_id_a" TEXT NOT NULL,
    "pool_id_b" TEXT NOT NULL,
    "price_a" DECIMAL(30,18) NOT NULL,
    "price_b" DECIMAL(30,18) NOT NULL,
    "deviation_percentage" DECIMAL(10,4) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "block_number" BIGINT NOT NULL,

    CONSTRAINT "_price_deviations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_arbitrage_opportunities" (
    "id" TEXT NOT NULL,
    "pair" VARCHAR(50) NOT NULL,
    "pair_key" TEXT,
    "token_a" VARCHAR(56) NOT NULL,
    "token_b" VARCHAR(56) NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "buy_pool_id" TEXT,
    "sell_pool_id" TEXT,
    "buy_price" DECIMAL(30,18) NOT NULL,
    "sell_price" DECIMAL(30,18) NOT NULL,
    "profit_percentage" DECIMAL(10,4) NOT NULL,
    "profit_estimate" DECIMAL(30,0),
    "capital_required" DECIMAL(30,0),
    "confidence" DECIMAL(5,4),
    "route" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "detected_at" TIMESTAMP(3) NOT NULL,
    "expired_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "execution_tx_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_arbitrage_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_mev_opportunity_scores" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "profitability_score" DECIMAL(5,2),
    "capital_efficiency" DECIMAL(10,4),
    "speed_requirement" VARCHAR(20),
    "competition_level" VARCHAR(20),
    "slippage_risk" DECIMAL(5,2),
    "frontrunning_risk" DECIMAL(5,2),
    "overall_score" DECIMAL(5,2),
    "recommendation" VARCHAR(50),
    "scored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_mev_opportunity_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_arbitrage_executions" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
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
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_arbitrage_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_arbitrage_bots" (
    "id" TEXT NOT NULL,
    "address" VARCHAR(56) NOT NULL,
    "first_seen" TIMESTAMP(3) NOT NULL,
    "last_seen" TIMESTAMP(3) NOT NULL,
    "total_trades" INTEGER NOT NULL DEFAULT 0,
    "successful_trades" INTEGER NOT NULL DEFAULT 0,
    "failed_trades" INTEGER NOT NULL DEFAULT 0,
    "total_profit" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "total_gas_spent" DECIMAL(30,0) NOT NULL DEFAULT 0,
    "avg_profit_per_trade" DECIMAL(30,0),
    "success_rate" DECIMAL(5,4),
    "preferred_pairs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_dexs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avg_capital_per_trade" DECIMAL(30,0),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_arbitrage_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandwich_attacks" (
    "id" TEXT NOT NULL,
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
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sandwich_attacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_arbitrage_alerts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_arbitrage_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_pool_prices" (
    "id" BIGSERIAL NOT NULL,
    "pool_id" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "reserve_a" DECIMAL(30,0) NOT NULL,
    "reserve_b" DECIMAL(30,0) NOT NULL,
    "spot_price" DOUBLE PRECISION NOT NULL,
    "twap1m" DOUBLE PRECISION,
    "twap5m" DOUBLE PRECISION,
    "twap1h" DOUBLE PRECISION,

    CONSTRAINT "_pool_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_fee_events" (
    "id" BIGSERIAL NOT NULL,
    "tx_hash" VARCHAR(64) NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "fee_type" VARCHAR(40) NOT NULL,
    "destination" VARCHAR(40) NOT NULL,
    "amount" DECIMAL(30,7) NOT NULL,
    "token" VARCHAR(56) NOT NULL,
    "usd_value" DOUBLE PRECISION,
    "sender" VARCHAR(56),
    "receiver" VARCHAR(56),
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_fee_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_revenues" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "protocol_name" VARCHAR(120),
    "period" VARCHAR(10) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "total_fees" DECIMAL(30,7) NOT NULL,
    "swap_fees" DECIMAL(30,7),
    "withdraw_fees" DECIMAL(30,7),
    "performance_fees" DECIMAL(30,7),
    "protocol_fees" DECIMAL(30,7),
    "liquidation_fees" DECIMAL(30,7),
    "interest_spread" DECIMAL(30,7),
    "flash_loan_fees" DECIMAL(30,7),
    "referral_fees" DECIMAL(30,7),
    "lp_rewards" DECIMAL(30,7),
    "treasury_amount" DECIMAL(30,7),
    "burned_amount" DECIMAL(30,7),
    "staker_rewards" DECIMAL(30,7),
    "insurance_fund" DECIMAL(30,7),
    "ecosystem_fund" DECIMAL(30,7),
    "team_vesting" DECIMAL(30,7),
    "fee_token" VARCHAR(56),
    "usd_value" DOUBLE PRECISION,
    "tx_count" INTEGER,
    "unique_users" INTEGER,

    CONSTRAINT "_protocol_revenues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_yield_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "protocol_name" VARCHAR(120),
    "timestamp" TIMESTAMP(3) NOT NULL,
    "lp_apr1d" DOUBLE PRECISION,
    "lp_apr7d" DOUBLE PRECISION,
    "lp_apr30d" DOUBLE PRECISION,
    "staking_apr1d" DOUBLE PRECISION,
    "staking_apr7d" DOUBLE PRECISION,
    "staking_apr30d" DOUBLE PRECISION,
    "total_value_locked" DECIMAL(30,7),
    "staked_value" DECIMAL(30,7),
    "revenue_share" DOUBLE PRECISION,

    CONSTRAINT "_yield_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_profiles" (
    "id" TEXT NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "protocol_name" VARCHAR(120) NOT NULL,
    "tvl" DECIMAL(30,7),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_protocol_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_revenue_alerts" (
    "id" BIGSERIAL NOT NULL,
    "contract_address" VARCHAR(56) NOT NULL,
    "alert_type" VARCHAR(40) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_revenue_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_protocol_economics_snapshots" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "bucket_end" TIMESTAMP(3) NOT NULL,
    "tx_count" INTEGER NOT NULL,
    "total_fees" DOUBLE PRECISION NOT NULL,
    "fee_burn" DOUBLE PRECISION NOT NULL,
    "network_revenue" DOUBLE PRECISION NOT NULL,
    "avg_fee" DOUBLE PRECISION NOT NULL,
    "success_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_protocol_economics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feature_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "unit" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_feature_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feature_values" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "ledger" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_feature_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_prediction_scenarios" (
    "id" TEXT NOT NULL,
    "scenario_name" TEXT NOT NULL,
    "perturbations" JSONB,
    "horizon" INTEGER NOT NULL,
    "base_forecast_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_prediction_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_predictive_api_keies" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_predictive_api_keies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_amm_pools" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "asset_a_address" TEXT NOT NULL,
    "asset_b_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_amm_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_anonymity_set_snapshots" (
    "id" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "set_size" INTEGER NOT NULL,
    "effective_set_size" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_anonymity_set_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_attestations" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "chain_id" TEXT NOT NULL,
    "schema_id" TEXT NOT NULL,
    "attester" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "revoked" BOOLEAN NOT NULL,
    "signature" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "block_number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verification_msg" TEXT,
    "issued_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_attestations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_audit_logs" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "previous_state" JSONB,
    "new_state" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sensitive_read_audits" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "request_id" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sensitive_read_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_backfill_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "format" TEXT NOT NULL,
    "filters" JSONB,
    "status" TEXT NOT NULL,
    "progress" DOUBLE PRECISION,
    "file_url" TEXT,
    "file_size_bytes" INTEGER,
    "record_count" INTEGER,
    "completed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_backfill_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_bn254_gas_exemptions" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "bn254_ops" TEXT,
    "op_count" INTEGER,
    "fee_charged" TEXT,
    "estimated_wasm_fee" TEXT,
    "stroop_savings" TEXT,
    "savings_pct" DOUBLE PRECISION,
    "cpu_instructions" INTEGER,
    "msm_complexity" TEXT,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_bn254_gas_exemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_commodity_dual_signer_logs" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "commodity_type" TEXT NOT NULL,
    "commodity_code" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "trader_address" TEXT NOT NULL,
    "primary_signer_address" TEXT NOT NULL,
    "secondary_signer_address" TEXT NOT NULL,
    "quantity" TEXT,
    "unit" TEXT,
    "notional_value_usd" TEXT,
    "regulatory_jurisdiction" TEXT,
    "expires_at" TIMESTAMP(3),
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "primary_signed" BOOLEAN,
    "secondary_signed" BOOLEAN,
    "both_signed" BOOLEAN,
    "compliance_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_commodity_dual_signer_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_benchmark_snapshots" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "avg_cpu" DOUBLE PRECISION,
    "avg_memory" DOUBLE PRECISION,
    "avg_fee_stroops" DOUBLE PRECISION,
    "samples" INTEGER NOT NULL,
    "fees" JSONB,
    "cpus" JSONB,
    "mems" JSONB,
    "txs" JSONB,
    "ledger_sequence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_contract_benchmark_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_factories" (
    "id" TEXT NOT NULL,
    "parent_contract_address" TEXT NOT NULL,
    "child_contract_address" TEXT NOT NULL,
    "creation_transaction_hash" TEXT NOT NULL,
    "creation_ledger_sequence" INTEGER NOT NULL,
    "creation_timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_contract_factories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_de_anonymization_findings" (
    "id" TEXT NOT NULL,
    "source_tx" TEXT NOT NULL,
    "technique" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "target_address" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_de_anonymization_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_derived_metrics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_derived_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_dtcc_settlement_bridges" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "dtcc_settlement_id" TEXT NOT NULL,
    "security_id" TEXT NOT NULL,
    "security_type" TEXT NOT NULL,
    "seller_address" TEXT NOT NULL,
    "buyer_address" TEXT NOT NULL,
    "quantity" TEXT,
    "settlement_amount" TEXT,
    "currency" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "settlement_date" TIMESTAMP(3),
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "settlement_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_dtcc_settlement_bridges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_endorsements" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "chain_id" TEXT NOT NULL,
    "endorser" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "weight" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3),
    "transaction_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_endorsements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_export_jobs" (
    "id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" DOUBLE PRECISION,
    "export_type" TEXT,
    "file_path" TEXT,
    "file_url" TEXT,
    "filters" JSONB,
    "error_msg" TEXT,
    "row_count" INTEGER,
    "completed_at" TIMESTAMP(3),
    "total_rows" INTEGER,
    "processed_rows" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_freeze_violations" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "frozen_keys" JSONB,
    "severity" TEXT,
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_freeze_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_frozen_ledger_keies" (
    "id" TEXT NOT NULL,
    "ledger_key" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "frozen_at_ledger" INTEGER NOT NULL,
    "frozen_at_time" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_frozen_ledger_keies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_fuzz_findings" (
    "id" TEXT NOT NULL,
    "fuzz_run_id" TEXT NOT NULL,
    "finding_type" TEXT,
    "description" TEXT,
    "severity" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_fuzz_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_fuzz_runs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "contract_id" TEXT,
    "status" TEXT NOT NULL,
    "total_cases" INTEGER NOT NULL,
    "unsafe_found" INTEGER NOT NULL,
    "coverage_pct" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_fuzz_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_analytics_snapshots" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "bucket_end" TIMESTAMP(3) NOT NULL,
    "avg_fee" DOUBLE PRECISION,
    "median_fee" DOUBLE PRECISION,
    "peak_fee" DOUBLE PRECISION,
    "min_fee" DOUBLE PRECISION,
    "tx_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_gas_analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_gas_golfing_tips" (
    "id" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "tips" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_gas_golfing_tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_contracts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "governance_type" TEXT NOT NULL,
    "voting_token" TEXT,
    "quorum_bps" INTEGER,
    "voting_period_ledgers" INTEGER,
    "proposal_threshold" TEXT,
    "timelock_delay_secs" INTEGER,
    "guardian" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "voice_credits_per_round" INTEGER,
    "min_token_holding" TEXT,
    "min_reputation_score" DOUBLE PRECISION,
    "conviction_half_life_ledgers" INTEGER,
    "conviction_max_ratio_bps" INTEGER,
    "multisig_threshold" INTEGER,
    "metadata" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_governance_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_delegates" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "delegatee" TEXT NOT NULL,
    "delegated_votes" TEXT,
    "delegators" INTEGER,
    "proposals_voted" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_governance_delegates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_delegations" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "delegator" TEXT NOT NULL,
    "delegatee" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'all',
    "transaction_hash" TEXT,
    "ledger_sequence" INTEGER,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_governance_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_voice_credits" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "holder" TEXT NOT NULL,
    "budget" INTEGER NOT NULL,
    "spent" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_governance_voice_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_multisig_signers" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "transaction_hash" TEXT,

    CONSTRAINT "_governance_multisig_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_proposals" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targets" JSONB NOT NULL,
    "values" JSONB,
    "calldatas" JSONB,
    "voting_model" TEXT,
    "template" TEXT,
    "snapshot_ledger" INTEGER,
    "start_block" INTEGER NOT NULL,
    "end_block" INTEGER NOT NULL,
    "quorum" TEXT,
    "status" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3),
    "eta" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "execution_kind" TEXT,
    "executed_at" TIMESTAMP(3),
    "execution_tx_hash" TEXT,
    "votes_for" TEXT,
    "votes_against" TEXT,
    "votes_abstain" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_governance_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_governance_votes" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "weight" TEXT,
    "support" TEXT,
    "reason" TEXT,
    "voice_credits" INTEGER,
    "stake_amount" TEXT,
    "conviction_at" TEXT,
    "last_update_ledger" INTEGER,
    "transaction_hash" TEXT,
    "ledger_sequence" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_governance_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_treasury_accounts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "account_address" TEXT NOT NULL,
    "name" TEXT,
    "reputation_weight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_treasury_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_treasury_assets" (
    "id" TEXT NOT NULL,
    "treasury_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "token_address" TEXT,
    "balance" TEXT NOT NULL DEFAULT '0',
    "decimals" INTEGER NOT NULL DEFAULT 7,
    "value_usd" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_treasury_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_treasury_payout_streams" (
    "id" TEXT NOT NULL,
    "treasury_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "token_address" TEXT,
    "amount_per_period" TEXT NOT NULL,
    "period_seconds" INTEGER NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3),
    "claimed" TEXT NOT NULL DEFAULT '0',
    "proposal_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_treasury_payout_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_treasury_transactions" (
    "id" TEXT NOT NULL,
    "treasury_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "token_address" TEXT,
    "amount" TEXT NOT NULL,
    "counterparty" TEXT,
    "category" TEXT,
    "transaction_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_treasury_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_linked_identities" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "chain_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "metadata" JSONB,
    "last_verified" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_linked_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_market_data_snapshots" (
    "id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "token_symbol" TEXT,
    "price_usd" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,
    "tvl" DOUBLE PRECISION,
    "liquidity" DOUBLE PRECISION,
    "price_change1h" DOUBLE PRECISION,
    "price_change24h" DOUBLE PRECISION,
    "trades24h" INTEGER,
    "unique_traders24h" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_market_data_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_network_nodes" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "port" INTEGER,
    "overlay_version" INTEGER,
    "ledger_version" INTEGER,
    "is_validator" BOOLEAN NOT NULL,
    "active_in_network" BOOLEAN NOT NULL,
    "agreement_rate24h" DOUBLE PRECISION,
    "agreement_rate7d" DOUBLE PRECISION,
    "agreement_rate30d" DOUBLE PRECISION,
    "country" TEXT,
    "country_code" TEXT,
    "first_seen" TIMESTAMP(3),
    "last_seen" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "missed_slots24h" INTEGER,
    "missed_slots7d" INTEGER,
    "name" TEXT,
    "network_profile" TEXT,
    "node_events" JSONB,
    "node_metrics" JSONB,
    "organization" TEXT,
    "organization_name" TEXT,
    "public_key" TEXT,
    "quorum_set" JSONB,
    "quorum_votes" INTEGER,
    "round_trip_latency_ms" INTEGER,
    "state" TEXT,
    "stellar_core_version" TEXT,
    "uptime24h" DOUBLE PRECISION,
    "uptime7d" DOUBLE PRECISION,
    "uptime30d" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_network_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_operation_benchmarks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avg_cpu" DOUBLE PRECISION,
    "avg_memory" DOUBLE PRECISION,
    "avg_fee_stroops" DOUBLE PRECISION,
    "samples" INTEGER NOT NULL,
    "last_updated" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_operation_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_oracle_callbacks" (
    "id" TEXT NOT NULL,
    "oracle_contract_address" TEXT NOT NULL,
    "data_requestor_address" TEXT NOT NULL,
    "request_timestamp" TIMESTAMP(3) NOT NULL,
    "round_trip_latency_ms" INTEGER,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_oracle_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_pool_snapshots" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "reserve_a" TEXT,
    "reserve_b" TEXT,
    "tvl_usd" DOUBLE PRECISION,
    "volume24h_usd" DOUBLE PRECISION,
    "fees24h_usd" DOUBLE PRECISION,
    "apr_pct" DOUBLE PRECISION,
    "price_a_usd" DOUBLE PRECISION,
    "price_b_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_pool_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_pool_swaps" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "token_in" TEXT NOT NULL,
    "amount_in" TEXT,
    "transaction_hash" TEXT,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_pool_swaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "asset_code" TEXT,
    "asset_issuer" TEXT,
    "estimated_volume" DOUBLE PRECISION,
    "price_xlm" DOUBLE PRECISION,
    "price_usd" DOUBLE PRECISION,
    "value_xlm" DOUBLE PRECISION,
    "value_usd" DOUBLE PRECISION,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_privacy_analytics" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "period" TEXT,
    "total_private_tx" INTEGER,
    "total_tx" INTEGER,
    "total_volume" DOUBLE PRECISION,
    "privacy_share" DOUBLE PRECISION,
    "volume_share" DOUBLE PRECISION,
    "by_protocol" JSONB,
    "avg_anonymity_set" DOUBLE PRECISION,
    "max_anonymity_set" INTEGER,
    "median_anonymity_set" INTEGER,
    "avg_privacy_score" DOUBLE PRECISION,
    "avg_risk_score" DOUBLE PRECISION,
    "unique_users" INTEGER,
    "unique_contracts" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_privacy_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_privacy_compliance_reports" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "total_private_tx" INTEGER,
    "protocols_used" TEXT[],
    "risk_score" DOUBLE PRECISION,
    "flagged" BOOLEAN NOT NULL,
    "flag_reason" TEXT,
    "compliance_label" TEXT,
    "linked_addresses" TEXT[],
    "last_activity" TIMESTAMP(3) NOT NULL,
    "report_generated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_privacy_compliance_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_privacy_protocol_details" (
    "id" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "period" TEXT,
    "tx_count" INTEGER,
    "volume" DOUBLE PRECISION,
    "unique_users" INTEGER,
    "unique_contracts" INTEGER,
    "avg_anonymity_set" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_privacy_protocol_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_privacy_transactions" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "protocols" TEXT[],
    "guarantees" TEXT[],
    "cryptographic_primitives" JSONB,
    "anonymity_set_size" INTEGER,
    "effective_anonymity_set" INTEGER,
    "privacy_score" DOUBLE PRECISION,
    "risk_score" DOUBLE PRECISION,
    "total_value" TEXT,
    "usd_value" DOUBLE PRECISION,
    "asset_type" TEXT,
    "participants" TEXT[],
    "contract_addresses" TEXT[],
    "participant_count" INTEGER,
    "ledger_sequence" INTEGER,
    "source_account" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_privacy_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reentrancy_alerts" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "severity" TEXT,
    "repeated_withdraw_calls" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reentrancy_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_registered_dapps" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_registered_dapps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_badges" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "badge_type" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_delegations" (
    "id" TEXT NOT NULL,
    "delegator" TEXT NOT NULL,
    "delegatee" TEXT NOT NULL,
    "amount" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_disputes" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "challenger" TEXT NOT NULL,
    "respondent" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "challenge" TEXT,
    "evidence_hash" TEXT,
    "quorum_votes" INTEGER,
    "outcome" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_reputation_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_dispute_votes" (
    "id" TEXT NOT NULL,
    "dispute_id" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "vote" TEXT,
    "weight" DOUBLE PRECISION,
    "signature" TEXT,
    "transaction_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_dispute_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_governance_votes" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "vote" TEXT,
    "weight" DOUBLE PRECISION,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_governance_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_nfts" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "badge_type" TEXT NOT NULL,
    "token_id" TEXT,
    "minted_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_nfts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_profiles" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT,
    "combined_score" DOUBLE PRECISION,
    "soroban_score" DOUBLE PRECISION,
    "stellar_score" DOUBLE PRECISION,
    "eth_score" DOUBLE PRECISION,
    "sol_score" DOUBLE PRECISION,
    "category_scores" JSONB,
    "signal_breakdown" JSONB,
    "categories" TEXT[],
    "badge_ids" TEXT[],
    "last_updated" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_reputation_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_trust_connections" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "from_address" TEXT,
    "to_address" TEXT,
    "chain_id" TEXT,
    "type" TEXT,
    "timestamp" TIMESTAMP(3),
    "transaction_hash" TEXT,
    "weight" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_trust_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_reputation_signals" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "signal_type" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "normalized_score" DOUBLE PRECISION,
    "chain" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_reputation_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_rwa_compliance_events" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "asset_contract_address" TEXT NOT NULL,
    "issuer_address" TEXT,
    "target_address" TEXT,
    "amount" TEXT,
    "compliance_reason" TEXT,
    "human_statement" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_rwa_compliance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_accounts" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "public_key" TEXT,
    "balance" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sandbox_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_calls" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "contract_id" TEXT,
    "function_name" TEXT NOT NULL,
    "args" JSONB,
    "results" JSONB,
    "gas_used" INTEGER,
    "success" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sandbox_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_ci_runs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "passed" INTEGER,
    "failed" INTEGER,
    "total_tests" INTEGER,
    "logs" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sandbox_ci_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_contracts" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "contract_id" TEXT,
    "name" TEXT,
    "state" JSONB,
    "abi" JSONB,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sandbox_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "state" TEXT,
    "context" JSONB,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_sandbox_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_shares" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "share_id" TEXT NOT NULL,
    "view_only" BOOLEAN,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sandbox_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_sandbox_snapshots" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "label" TEXT,
    "state" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_sandbox_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_settlement_batch_summaries" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "ledger_min" INTEGER NOT NULL,
    "ledger_max" INTEGER NOT NULL,
    "tx_count" INTEGER NOT NULL,
    "total_amount" TEXT,
    "batch_id" TEXT NOT NULL,
    "window_key" TEXT,
    "event_count" INTEGER,
    "compacted" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_settlement_batch_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_shielded_transfers" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "amount" TEXT,
    "is_confidential" BOOLEAN NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_shielded_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_signature_inspections" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "curve_type" TEXT,
    "is_passkey" BOOLEAN,
    "pub_key_x" TEXT,
    "pub_key_y" TEXT,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_signature_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_signer_snapshots" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "signers" JSONB,
    "high_threshold" INTEGER,
    "ledger_sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_signer_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_standard_compliances" (
    "id" TEXT NOT NULL,
    "contract_type" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "max_fee_stroops" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_standard_compliances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_state_contentions" (
    "id" TEXT NOT NULL,
    "ledger_sequence" INTEGER NOT NULL,
    "contract_address" TEXT NOT NULL,
    "state_key" TEXT,
    "tx_hashes" TEXT[],
    "conflict_count" INTEGER,
    "delay_ms" INTEGER,
    "delay_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_state_contentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_threat_advisories" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL,
    "cvss_score" DOUBLE PRECISION,
    "cve_id" TEXT,
    "ghsa_id" TEXT,
    "affected_contracts" TEXT[],
    "affected_chains" TEXT[],
    "mitigations" TEXT,
    "tags" TEXT[],
    "source_id" TEXT,
    "status" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "external_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_threat_advisories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_threat_comments" (
    "id" TEXT NOT NULL,
    "advisory_id" TEXT NOT NULL,
    "author_key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_threat_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_threat_reviews" (
    "id" TEXT NOT NULL,
    "advisory_id" TEXT NOT NULL,
    "role" TEXT,
    "decision" TEXT,
    "notes" TEXT,
    "reviewer_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_threat_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_tip_subscriptions" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "filters" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_tip_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_tip_webhooks" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" JSONB,
    "secret" TEXT,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_tip_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "symbol" TEXT,
    "decimals" INTEGER,
    "totalSupply" DECIMAL(30,7),
    "contractAddress" TEXT,
    "circulatingSupply" DECIMAL(30,7),
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "transferCount24h" INTEGER NOT NULL DEFAULT 0,
    "uniqueSenders24h" INTEGER NOT NULL DEFAULT 0,
    "uniqueReceivers24h" INTEGER NOT NULL DEFAULT 0,
    "averageTransferValueUsd" DECIMAL(30,7),
    "isStablecoin" BOOLEAN NOT NULL DEFAULT false,
    "stablecoinPeg" TEXT,
    "pegDeviation24h" DOUBLE PRECISION,
    "pegStabilityScore" DOUBLE PRECISION,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_token_prices" (
    "id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "price_usd" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "price_xlm" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'composite',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume24h_usd" DECIMAL(65,30),
    "volume24h_xlm" DECIMAL(65,30),
    "market_cap_usd" DECIMAL(65,30),
    "fully_diluted_valuation" DECIMAL(65,30),
    "circulating_supply" DECIMAL(65,30),
    "total_supply" DECIMAL(65,30),
    "price_change1h" DOUBLE PRECISION,
    "price_change24h" DOUBLE PRECISION,
    "price_change7d" DOUBLE PRECISION,
    "twap1h" DECIMAL(65,30),
    "twap24h" DECIMAL(65,30),
    "liquidity_usd" DECIMAL(65,30),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_token_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_token_price_histories" (
    "id" TEXT NOT NULL,
    "token_address" TEXT NOT NULL,
    "price_usd" DECIMAL(65,30) NOT NULL,
    "price_xlm" DECIMAL(65,30) NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "volume24h_usd" DECIMAL(65,30),
    "market_cap_usd" DECIMAL(65,30),
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_token_price_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_price_alerts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "token_address" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "threshold" TEXT NOT NULL,
    "time_window" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_price_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_verifiable_credentials" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "context" TEXT,
    "type" TEXT,
    "issuer" TEXT,
    "issuance_date" TIMESTAMP(3),
    "expiration_date" TIMESTAMP(3),
    "subject_id" TEXT,
    "subject_data" JSONB,
    "proof_type" TEXT,
    "proof_created" TIMESTAMP(3),
    "verification_method" TEXT,
    "proof_purpose" TEXT,
    "proof_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_verifiable_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_volume_alerts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL,
    "baseline" DOUBLE PRECISION,
    "current_count" INTEGER,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "severity" TEXT,
    "std_dev" DOUBLE PRECISION,
    "message" TEXT,
    "window_minutes" INTEGER,
    "z_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_volume_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_vulnerability_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "feed_url" TEXT,
    "last_fetch_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_vulnerability_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_id" TEXT,
    "attempt" INTEGER,
    "status" TEXT,
    "processing_status" TEXT NOT NULL DEFAULT 'idle',
    "lease_expires_at" TIMESTAMP(3),
    "http_status" INTEGER,
    "response_body" TEXT,
    "error_msg" TEXT,
    "delivered_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "contract_address" TEXT,
    "event_type" TEXT,
    "topic_symbol" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "store_response_body" BOOLEAN NOT NULL DEFAULT true,
    "response_retention_days" INTEGER NOT NULL DEFAULT 90,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_yield_distributions" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "distribution_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" TEXT,
    "token_symbol" TEXT,
    "window_label" TEXT,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_yield_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_yield_history_snapshots" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "apy" DOUBLE PRECISION,
    "base_apy" DOUBLE PRECISION,
    "incentive_apy" DOUBLE PRECISION,
    "tvl" DOUBLE PRECISION,
    "ledger_sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_yield_history_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_yield_opportunities" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tokens" TEXT[],
    "base_apy" DOUBLE PRECISION,
    "incentive_apy" DOUBLE PRECISION,
    "total_apy" DOUBLE PRECISION,
    "tvl" DOUBLE PRECISION,
    "lockup_days" INTEGER,
    "min_deposit" TEXT,
    "deposit_fee" DOUBLE PRECISION,
    "withdraw_fee" DOUBLE PRECISION,
    "risk_score" DOUBLE PRECISION,
    "risk_label" TEXT,
    "last_observed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_yield_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_zkp_verification_events" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "proof_type" TEXT,
    "public_input_hash" TEXT,
    "verification_result" BOOLEAN,
    "certainty_percent" DOUBLE PRECISION,
    "ledger_sequence" INTEGER NOT NULL,
    "ledger_close_time" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_zkp_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_graph_vertices" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "call_index" INTEGER NOT NULL,
    "value" TEXT,
    "pre_state_reads" JSONB,
    "post_state_writes" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_graph_vertices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_graph_edges" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "from_vertex_id" TEXT NOT NULL,
    "to_vertex_id" TEXT NOT NULL,
    "function_name" TEXT NOT NULL,
    "value" TEXT,
    "gas_forwarded" INTEGER,
    "args_hash" TEXT,
    "call_index" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_graph_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reentrancy_findings" (
    "id" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "reentrancy_type" "ReentrancyType" NOT NULL,
    "severity" "ReentrancySeverity" NOT NULL,
    "likelihood" TEXT NOT NULL,
    "loopPath" JSONB NOT NULL,
    "entry_point" TEXT NOT NULL,
    "value_at_risk" TEXT,
    "usd_value_at_risk" DOUBLE PRECISION,
    "profit_potential" DOUBLE PRECISION,
    "description" TEXT NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reentrancy_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_risk_scores" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "previous_score" INTEGER,
    "total_findings" INTEGER NOT NULL,
    "critical_findings" INTEGER NOT NULL,
    "high_findings" INTEGER NOT NULL,
    "medium_findings" INTEGER NOT NULL,
    "risk_factors" JSONB NOT NULL,
    "last_analyzed" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_risk_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reentrancy_alerts" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "finding_id" TEXT,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "reentrancy_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reentrancy_stats" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "total_call_graphs" INTEGER NOT NULL,
    "contracts_analyzed" INTEGER NOT NULL,
    "contracts_with_loops" INTEGER NOT NULL,
    "high_risk_contracts" INTEGER NOT NULL,
    "critical_findings" INTEGER NOT NULL,
    "total_findings" INTEGER NOT NULL,
    "most_common_patterns" JSONB NOT NULL,
    "avg_depth" DOUBLE PRECISION,
    "max_depth" INTEGER,
    "value_at_risk_total" TEXT,

    CONSTRAINT "reentrancy_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_queries" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "query" TEXT NOT NULL,
    "language" TEXT,
    "interpretedQuery" JSONB,
    "sql" TEXT,
    "apiEndpoint" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "responseTime" INTEGER,
    "tokensUsed" INTEGER,
    "feedback" "QueryFeedback",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nl_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_query_contexts" (
    "id" TEXT NOT NULL,
    "query_id" TEXT NOT NULL,
    "session_id" TEXT,
    "previous_queries" JSONB,
    "resolved_entities" JSONB,
    "active_filters" JSONB,
    "context_window" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nl_query_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nl_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_queries" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "nl_template" TEXT NOT NULL,
    "parameters" JSONB,
    "schedule" TEXT,
    "last_run" TIMESTAMP(3),
    "next_run" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "query_id" TEXT,

    CONSTRAINT "saved_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_embeddings" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "intent" TEXT NOT NULL,
    "filters" JSONB,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "success_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nl_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_query_templates" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nl_template" TEXT NOT NULL,
    "parameters" JSONB,
    "category" TEXT,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nl_query_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "nl_template" TEXT NOT NULL,
    "parameters" JSONB,
    "schedule" TEXT,
    "report_type" TEXT NOT NULL DEFAULT 'one-time',
    "webhook_url" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_run" TIMESTAMP(3),
    "next_run" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nl_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_report_history" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nl_report_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nl_alerts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "nl_query" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "conditions" JSONB,
    "webhook_url" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_fired" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nl_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archival_nodes" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,
    "endpoint" TEXT NOT NULL,
    "stakedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stakeAsset" TEXT NOT NULL DEFAULT 'XLM',
    "commission" DOUBLE PRECISION,
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reputationHistory" JSONB,
    "totalEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalServed" INTEGER NOT NULL DEFAULT 0,
    "totalChallenges" INTEGER NOT NULL DEFAULT 0,
    "challengesPassed" INTEGER NOT NULL DEFAULT 0,
    "challengesFailed" INTEGER NOT NULL DEFAULT 0,
    "uptime24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptime7d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptime30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgResponseTime" INTEGER,
    "p95ResponseTime" INTEGER,
    "maxStorageGb" INTEGER,
    "usedStorageGb" INTEGER,
    "supportedEpochs" JSONB,
    "slashedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "ArchivalNodeStatus" NOT NULL DEFAULT 'active',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archival_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archival_epochs" (
    "id" TEXT NOT NULL,
    "epochId" INTEGER NOT NULL,
    "startLedger" INTEGER NOT NULL,
    "endLedger" INTEGER NOT NULL,
    "sizeBytes" BIGINT,
    "checksum" TEXT,
    "merkleRoot" TEXT,
    "nodeId" TEXT NOT NULL,
    "status" "EpochStatus" NOT NULL DEFAULT 'stored',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archival_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_challenges" (
    "id" TEXT NOT NULL,
    "epochId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "challengeType" TEXT NOT NULL,
    "challengeData" JSONB,
    "responseData" JSONB,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "proofVerified" BOOLEAN,
    "slashed" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "storage_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retrievals" (
    "id" TEXT NOT NULL,
    "requester" TEXT NOT NULL,
    "epochId" TEXT,
    "nodeId" TEXT,
    "ledgerRange" JSONB,
    "contractId" TEXT,
    "fee" DOUBLE PRECISION NOT NULL,
    "feeAsset" TEXT NOT NULL,
    "status" "RetrievalStatus" NOT NULL,
    "responseSize" INTEGER,
    "responseTime" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "data_retrievals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_offers" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "uptime" DOUBLE PRECISION NOT NULL,
    "responseMs" INTEGER NOT NULL,
    "description" TEXT,
    "pricePerGb" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_acceptances" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "requester" TEXT NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archival_slashes" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "challengeId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archival_slashes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archival_appeals" (
    "id" TEXT NOT NULL,
    "slashId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "archival_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_collections" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "name" TEXT,
    "symbol" TEXT,
    "description" TEXT,
    "category" TEXT,
    "total_supply" INTEGER NOT NULL DEFAULT 0,
    "unique_holders" INTEGER NOT NULL DEFAULT 0,
    "floor_price" DECIMAL(65,30),
    "floor_price_token" TEXT,
    "floor_price_usd" DECIMAL(65,30),
    "total_volume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume7d" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume30d" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "avg_price24h" DECIMAL(65,30),
    "avg_price7d" DECIMAL(65,30),
    "market_cap" DECIMAL(65,30),
    "mint_price" DECIMAL(65,30),
    "mint_start" TIMESTAMP(3),
    "mint_end" TIMESTAMP(3),
    "royalty_pct" DOUBLE PRECISION,
    "royalty_recipient" TEXT,
    "website" TEXT,
    "discord" TEXT,
    "twitter" TEXT,
    "logo_uri" TEXT,
    "banner_uri" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_spam" BOOLEAN NOT NULL DEFAULT false,
    "is_mintable" BOOLEAN NOT NULL DEFAULT false,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_sale_at" TIMESTAMP(3),

    CONSTRAINT "_nft_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_items" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "minted_at" TIMESTAMP(3) NOT NULL,
    "mint_tx_hash" TEXT NOT NULL,
    "mint_price" DECIMAL(65,30),
    "last_sale_price" DECIMAL(65,30),
    "last_sale_price_usd" DECIMAL(65,30),
    "last_sale_at" TIMESTAMP(3),
    "sale_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "metadata_uri" TEXT,
    "metadata_fetched_at" TIMESTAMP(3),
    "rarity_score" DOUBLE PRECISION,
    "rarity_rank" INTEGER,
    "is_listed" BOOLEAN NOT NULL DEFAULT false,
    "listing_price" DECIMAL(65,30),
    "listing_market" TEXT,
    "is_soulbound" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_nft_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_traits" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "trait_type" TEXT NOT NULL,
    "trait_value" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "rarity_score" DOUBLE PRECISION,
    "rarity_tier" TEXT,

    CONSTRAINT "_nft_traits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_sales" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "item_id" TEXT,
    "token_id" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "price_usd" DECIMAL(65,30),
    "price_token" TEXT,
    "tx_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER,
    "marketplace" TEXT,
    "sale_type" TEXT NOT NULL,
    "sale_at" TIMESTAMP(3) NOT NULL,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_wash_trade" BOOLEAN NOT NULL DEFAULT false,
    "wash_trade_score" DOUBLE PRECISION,

    CONSTRAINT "_nft_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_listings" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "price_usd" DECIMAL(65,30),
    "price_token" TEXT,
    "marketplace" TEXT,
    "listed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "_nft_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_collection_stats" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "floor_price" DECIMAL(65,30),
    "floor_price_usd" DECIMAL(65,30),
    "total_volume" DECIMAL(65,30) NOT NULL,
    "volume24h" DECIMAL(65,30) NOT NULL,
    "avg_price24h" DECIMAL(65,30),
    "unique_holders" INTEGER NOT NULL,
    "total_supply" INTEGER NOT NULL,
    "wash_volume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "wash_tx_count24h" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "_nft_collection_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_portfolios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT,
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_value_usd" DECIMAL(65,30),
    "total_paid_usd" DECIMAL(65,30),
    "unrealized_pnl_usd" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_nft_portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_activities" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "item_id" TEXT,
    "token_id" TEXT NOT NULL,
    "activity_type" TEXT NOT NULL,
    "from_address" TEXT,
    "to_address" TEXT,
    "price" DECIMAL(65,30),
    "price_usd" DECIMAL(65,30),
    "tx_hash" TEXT NOT NULL,
    "ledger_sequence" INTEGER,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "_nft_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_nft_marketplaces" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "website" TEXT,
    "logo_uri" TEXT,
    "total_volume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_listings" INTEGER NOT NULL DEFAULT 0,
    "active_listings" INTEGER NOT NULL DEFAULT 0,
    "unique_collections" INTEGER NOT NULL DEFAULT 0,
    "active_traders24h" INTEGER NOT NULL DEFAULT 0,
    "fee_pct" DOUBLE PRECISION,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_nft_marketplaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_api_audit_logs" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT,
    "key_name" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'unauthenticated',
    "ip" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_time_ms" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_remaining" INTEGER,
    "rate_limit_limit" INTEGER,
    "user_agent" TEXT,
    "request_id" TEXT,
    "region" TEXT,
    "is_rate_limited" BOOLEAN NOT NULL DEFAULT false,
    "month" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_api_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_abuse_events" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "ip" TEXT,
    "api_key_id" TEXT,
    "endpoint" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL DEFAULT 'monitor',
    "blocked_until" TIMESTAMP(3),
    "evidence" JSONB,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_abuse_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_transactions" (
    "id" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "sourceChain" VARCHAR(50) NOT NULL,
    "destinationChain" VARCHAR(50) NOT NULL,
    "asset" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(30,7) NOT NULL,
    "sender" VARCHAR(100) NOT NULL,
    "recipient" VARCHAR(100) NOT NULL,
    "protocol" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "requiredConfirmations" INTEGER NOT NULL DEFAULT 0,
    "sourceTimestamp" TIMESTAMP(3),
    "destinationTimestamp" TIMESTAMP(3),
    "estimatedArrivalAt" TIMESTAMP(3),
    "bridgeFee" DECIMAL(20,7),
    "sourceTxUrl" TEXT,
    "destinationTxUrl" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bridge_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_alerts" (
    "id" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'info',
    "protocol" VARCHAR(50),
    "chain" VARCHAR(50),
    "address" VARCHAR(100),
    "transactionHash" VARCHAR(100),
    "asset" VARCHAR(50),
    "amount" DECIMAL(30,7),
    "message" TEXT NOT NULL,
    "data" JSONB,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_dependencies" (
    "id" TEXT NOT NULL,
    "sourceAddress" TEXT NOT NULL,
    "targetAddress" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_volumes" (
    "id" TEXT NOT NULL,
    "protocol" VARCHAR(50) NOT NULL,
    "chain" VARCHAR(50) NOT NULL,
    "asset" VARCHAR(50) NOT NULL,
    "volume" DECIMAL(30,7) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "period" VARCHAR(20) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_users" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "tier" TEXT NOT NULL DEFAULT 'free',
    "displayName" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isMultiSig" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceInfo" JSONB,
    "appId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "eventType" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_webhooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multisig_wallets" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "signers" JSONB NOT NULL,
    "threshold" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multisig_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_apps" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" JSONB NOT NULL,
    "scopes" JSONB NOT NULL,
    "ownerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wasm_abi_extracts" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "functions" JSONB NOT NULL,
    "exports" JSONB NOT NULL,
    "imports" JSONB NOT NULL,
    "sepStandards" TEXT[],
    "coverageScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "warnings" TEXT[],
    "wasmHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wasm_abi_extracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abi_coverage_reports" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "totalCalls" INTEGER NOT NULL,
    "matchedCalls" INTEGER NOT NULL,
    "coveragePercent" DOUBLE PRECISION NOT NULL,
    "falsePositives" TEXT[],
    "falseNegatives" TEXT[],
    "confidenceByFunction" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abi_coverage_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abi_community_contributions" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "functionName" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "returns" TEXT NOT NULL,
    "contributor" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abi_community_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_kyc_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'tier1',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentType" TEXT,
    "documentCountry" TEXT,
    "livenessScore" DOUBLE PRECISION,
    "pepScreened" BOOLEAN NOT NULL DEFAULT false,
    "sanctionsScreened" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "providerKycIds" JSONB NOT NULL DEFAULT '{}',
    "dailyLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "monthlyLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "dailyUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "monthlyUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usageResetAt" TIMESTAMP(3),
    "jurisdiction" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ramp_kyc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kycId" TEXT,
    "direction" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fiatAmount" DOUBLE PRECISION NOT NULL,
    "fiatCurrency" TEXT NOT NULL DEFAULT 'USD',
    "cryptoAmount" DOUBLE PRECISION,
    "cryptoAsset" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "exchangeRate" DOUBLE PRECISION,
    "platformFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "networkFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "refundAmount" DOUBLE PRECISION,
    "refundStatus" TEXT,
    "refundedAt" TIMESTAMP(3),
    "userIp" TEXT,
    "userCountry" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ramp_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_order_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'system',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ramp_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_reconciliations" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "periodDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ordersChecked" INTEGER NOT NULL DEFAULT 0,
    "discrepancyCount" INTEGER NOT NULL DEFAULT 0,
    "discrepancies" JSONB NOT NULL DEFAULT '[]',
    "totalVolumeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "runAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ramp_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_aml_flags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "flagType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ramp_aml_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_alerts" (
    "id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "target_address" TEXT NOT NULL,
    "risk_score" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "explanation" JSONB NOT NULL,
    "mitigation_applied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_feature_store" (
    "id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_feature_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_model_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "parameters" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_model_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_model_drift" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "feature_drifts" JSONB NOT NULL,
    "prediction_drift" DOUBLE PRECISION NOT NULL,
    "drift_threshold_exceeded" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_model_drift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_fraud_retraining_logs" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dataset_size" INTEGER NOT NULL,
    "accuracy_after" DOUBLE PRECISION NOT NULL,
    "precision_after" DOUBLE PRECISION NOT NULL,
    "recall_after" DOUBLE PRECISION NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_fraud_retraining_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_sources" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "imports" JSONB NOT NULL DEFAULT '[]',
    "exports" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "storage_variables" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_contract_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_contract_source_function_details" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pseudo_code" TEXT,
    "params" JSONB NOT NULL DEFAULT '[]',
    "returns" JSONB NOT NULL DEFAULT '[]',
    "selector" TEXT NOT NULL,
    "complexity" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_contract_source_function_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_search_index_entries" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_search_index_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "default_enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_percent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_feature_flag_overrides" (
    "id" TEXT NOT NULL,
    "flag_key" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "scope_value" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_fuzz_jobs" (
    "id" TEXT NOT NULL,
    "contract_address" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "report" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "_fuzz_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "_ledgers_hash_key" ON "_ledgers"("hash");

-- CreateIndex
CREATE INDEX "_ledgers_sequence_idx" ON "_ledgers"("sequence");

-- CreateIndex
CREATE INDEX "_ledgers_close_time_idx" ON "_ledgers"("close_time");

-- CreateIndex
CREATE INDEX "_wasm_upgrade_histories_contract_address_ledger_sequence_idx" ON "_wasm_upgrade_histories"("contract_address", "ledger_sequence");

-- CreateIndex
CREATE INDEX "_wasm_upgrade_histories_ledger_sequence_idx" ON "_wasm_upgrade_histories"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_wasm_upgrade_histories_is_suspicious_idx" ON "_wasm_upgrade_histories"("is_suspicious");

-- CreateIndex
CREATE INDEX "_wasm_upgrade_histories_change_classification_idx" ON "_wasm_upgrade_histories"("change_classification");

-- CreateIndex
CREATE UNIQUE INDEX "_transactions_hash_key" ON "_transactions"("hash");

-- CreateIndex
CREATE INDEX "_transactions_hash_idx" ON "_transactions"("hash");

-- CreateIndex
CREATE INDEX "_transactions_ledger_sequence_idx" ON "_transactions"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_transactions_source_account_idx" ON "_transactions"("source_account");

-- CreateIndex
CREATE INDEX "_transactions_contract_address_idx" ON "_transactions"("contract_address");

-- CreateIndex
CREATE INDEX "_transactions_status_idx" ON "_transactions"("status");

-- CreateIndex
CREATE INDEX "_transactions_contract_address_ledger_sequence_id_idx" ON "_transactions"("contract_address", "ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_transactions_source_account_ledger_sequence_id_idx" ON "_transactions"("source_account", "ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_transactions_status_ledger_sequence_id_idx" ON "_transactions"("status", "ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_transactions_ledger_sequence_id_idx" ON "_transactions"("ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_transactions_ledger_close_time_id_idx" ON "_transactions"("ledger_close_time", "id");

-- CreateIndex
CREATE INDEX "_events_transaction_hash_idx" ON "_events"("transaction_hash");

-- CreateIndex
CREATE INDEX "_events_contract_address_idx" ON "_events"("contract_address");

-- CreateIndex
CREATE INDEX "_events_event_type_idx" ON "_events"("event_type");

-- CreateIndex
CREATE INDEX "_events_topic_symbol_idx" ON "_events"("topic_symbol");

-- CreateIndex
CREATE INDEX "_events_ledger_sequence_idx" ON "_events"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_events_contract_address_topic_symbol_idx" ON "_events"("contract_address", "topic_symbol");

-- CreateIndex
CREATE INDEX "_events_contract_address_ledger_sequence_id_idx" ON "_events"("contract_address", "ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_events_contract_address_event_type_ledger_sequence_idx" ON "_events"("contract_address", "event_type", "ledger_sequence");

-- CreateIndex
CREATE INDEX "_events_ledger_sequence_id_idx" ON "_events"("ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_event_definitions_contract_address_idx" ON "_event_definitions"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "_event_definitions_contract_address_topic_symbol_key" ON "_event_definitions"("contract_address", "topic_symbol");

-- CreateIndex
CREATE INDEX "_audit_certificates_contract_address_status_idx" ON "_audit_certificates"("contract_address", "status");

-- CreateIndex
CREATE INDEX "_audit_certificates_overall_score_idx" ON "_audit_certificates"("overall_score" DESC);

-- CreateIndex
CREATE INDEX "_audit_certificates_created_at_idx" ON "_audit_certificates"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "_audit_certificates_contract_address_version_key" ON "_audit_certificates"("contract_address", "version");

-- CreateIndex
CREATE INDEX "_audit_findings_certificate_id_idx" ON "_audit_findings"("certificate_id");

-- CreateIndex
CREATE INDEX "_audit_findings_severity_status_idx" ON "_audit_findings"("severity", "status");

-- CreateIndex
CREATE INDEX "_audit_findings_category_idx" ON "_audit_findings"("category");

-- CreateIndex
CREATE INDEX "_audit_events_contract_address_timestamp_idx" ON "_audit_events"("contract_address", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "_audit_events_event_type_idx" ON "_audit_events"("event_type");

-- CreateIndex
CREATE INDEX "_audit_events_certificate_id_idx" ON "_audit_events"("certificate_id");

-- CreateIndex
CREATE UNIQUE INDEX "_contracts_address_key" ON "_contracts"("address");

-- CreateIndex
CREATE INDEX "_contracts_address_idx" ON "_contracts"("address");

-- CreateIndex
CREATE INDEX "_contracts_verification_badge_idx" ON "_contracts"("verification_badge");

-- CreateIndex
CREATE INDEX "_contracts_safety_score_idx" ON "_contracts"("safety_score");

-- CreateIndex
CREATE INDEX "_contracts_created_at_idx" ON "_contracts"("created_at");

-- CreateIndex
CREATE INDEX "_verification_runs_contract_address_idx" ON "_verification_runs"("contract_address");

-- CreateIndex
CREATE INDEX "_verification_runs_status_idx" ON "_verification_runs"("status");

-- CreateIndex
CREATE INDEX "_verification_runs_safety_score_idx" ON "_verification_runs"("safety_score");

-- CreateIndex
CREATE UNIQUE INDEX "_session_authorizations_event_id_key" ON "_session_authorizations"("event_id");

-- CreateIndex
CREATE INDEX "_session_authorizations_contract_address_idx" ON "_session_authorizations"("contract_address");

-- CreateIndex
CREATE INDEX "_session_authorizations_expiry_ledger_idx" ON "_session_authorizations"("expiry_ledger");

-- CreateIndex
CREATE UNIQUE INDEX "_dex_pools_pool_address_key" ON "_dex_pools"("pool_address");

-- CreateIndex
CREATE UNIQUE INDEX "_dex_pools_contract_address_key" ON "_dex_pools"("contract_address");

-- CreateIndex
CREATE INDEX "_dex_pools_pool_address_idx" ON "_dex_pools"("pool_address");

-- CreateIndex
CREATE INDEX "_dex_pools_protocol_idx" ON "_dex_pools"("protocol");

-- CreateIndex
CREATE INDEX "_dex_pools_tvl_usd_idx" ON "_dex_pools"("tvl_usd" DESC);

-- CreateIndex
CREATE INDEX "_dex_pools_is_active_idx" ON "_dex_pools"("is_active");

-- CreateIndex
CREATE INDEX "_dex_pools_dex_name_idx" ON "_dex_pools"("dex_name");

-- CreateIndex
CREATE UNIQUE INDEX "_vulnerability_advisories_advisory_id_key" ON "_vulnerability_advisories"("advisory_id");

-- CreateIndex
CREATE INDEX "_vulnerability_advisories_severity_idx" ON "_vulnerability_advisories"("severity");

-- CreateIndex
CREATE INDEX "_propagation_analysis_advisory_id_idx" ON "_propagation_analysis"("advisory_id");

-- CreateIndex
CREATE INDEX "_propagation_analysis_vulnerable_contract_idx" ON "_propagation_analysis"("vulnerable_contract");

-- CreateIndex
CREATE INDEX "_indexer_states_network_idx" ON "_indexer_states"("network");

-- CreateIndex
CREATE UNIQUE INDEX "_indexer_states_network_id_key" ON "_indexer_states"("network", "id");

-- CreateIndex
CREATE UNIQUE INDEX "_rate_limit_overrides_identifier_endpoint_key" ON "_rate_limit_overrides"("identifier", "endpoint");

-- CreateIndex
CREATE INDEX "_catch_up_checkpoints_completed_idx" ON "_catch_up_checkpoints"("completed");

-- CreateIndex
CREATE UNIQUE INDEX "_catch_up_checkpoints_range_start_range_end_key" ON "_catch_up_checkpoints"("range_start", "range_end");

-- CreateIndex
CREATE UNIQUE INDEX "_sac_mappings_sac_address_key" ON "_sac_mappings"("sac_address");

-- CreateIndex
CREATE INDEX "_sac_mappings_sac_address_idx" ON "_sac_mappings"("sac_address");

-- CreateIndex
CREATE INDEX "_sac_mappings_asset_code_idx" ON "_sac_mappings"("asset_code");

-- CreateIndex
CREATE UNIQUE INDEX "_sac_mappings_asset_code_asset_issuer_key" ON "_sac_mappings"("asset_code", "asset_issuer");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_g_account_idx" ON "_sac_trustline_mappings"("g_account");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_sac_address_idx" ON "_sac_trustline_mappings"("sac_address");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_asset_code_idx" ON "_sac_trustline_mappings"("asset_code");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_status_idx" ON "_sac_trustline_mappings"("status");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_ledger_sequence_idx" ON "_sac_trustline_mappings"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_sac_trustline_mappings_change_trust_op_ledger_idx" ON "_sac_trustline_mappings"("change_trust_op_ledger");

-- CreateIndex
CREATE UNIQUE INDEX "_sac_trustline_mappings_g_account_sac_address_key" ON "_sac_trustline_mappings"("g_account", "sac_address");

-- CreateIndex
CREATE INDEX "_verification_jobs_contract_address_idx" ON "_verification_jobs"("contract_address");

-- CreateIndex
CREATE INDEX "_verification_jobs_status_idx" ON "_verification_jobs"("status");

-- CreateIndex
CREATE INDEX "_contract_states_contract_address_idx" ON "_contract_states"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_states_status_idx" ON "_contract_states"("status");

-- CreateIndex
CREATE INDEX "_contract_states_live_until_ledger_seq_idx" ON "_contract_states"("live_until_ledger_seq");

-- CreateIndex
CREATE UNIQUE INDEX "_contract_states_contract_address_ledger_key_key" ON "_contract_states"("contract_address", "ledger_key");

-- CreateIndex
CREATE UNIQUE INDEX "_restoration_logs_transaction_hash_key" ON "_restoration_logs"("transaction_hash");

-- CreateIndex
CREATE INDEX "_restoration_logs_source_account_idx" ON "_restoration_logs"("source_account");

-- CreateIndex
CREATE INDEX "_restoration_logs_ledger_sequence_idx" ON "_restoration_logs"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_failed_items_item_type_dead_idx" ON "_failed_items"("item_type", "dead");

-- CreateIndex
CREATE INDEX "_failed_items_ledger_idx" ON "_failed_items"("ledger");

-- CreateIndex
CREATE INDEX "_dead_letter_items_item_type_idx" ON "_dead_letter_items"("item_type");

-- CreateIndex
CREATE INDEX "_dead_letter_items_ledger_idx" ON "_dead_letter_items"("ledger");

-- CreateIndex
CREATE UNIQUE INDEX "_api_keies_key_hash_key" ON "_api_keies"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_smart_wallets_address_key" ON "_smart_wallets"("address");

-- CreateIndex
CREATE INDEX "_smart_wallets_wallet_type_idx" ON "_smart_wallets"("wallet_type");

-- CreateIndex
CREATE INDEX "_smart_wallets_first_seen_ledger_idx" ON "_smart_wallets"("first_seen_ledger");

-- CreateIndex
CREATE INDEX "_smart_wallets_deployed_by_account_idx" ON "_smart_wallets"("deployed_by_account");

-- CreateIndex
CREATE UNIQUE INDEX "_sponsored_transactions_transaction_hash_key" ON "_sponsored_transactions"("transaction_hash");

-- CreateIndex
CREATE INDEX "_sponsored_transactions_sponsor_account_idx" ON "_sponsored_transactions"("sponsor_account");

-- CreateIndex
CREATE INDEX "_sponsored_transactions_source_account_idx" ON "_sponsored_transactions"("source_account");

-- CreateIndex
CREATE INDEX "_sponsored_transactions_wallet_address_idx" ON "_sponsored_transactions"("wallet_address");

-- CreateIndex
CREATE INDEX "_sponsored_transactions_ledger_sequence_idx" ON "_sponsored_transactions"("ledger_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "_auth_decompositions_transaction_hash_key" ON "_auth_decompositions"("transaction_hash");

-- CreateIndex
CREATE INDEX "_auth_decompositions_wallet_address_idx" ON "_auth_decompositions"("wallet_address");

-- CreateIndex
CREATE INDEX "_auth_decompositions_ledger_sequence_idx" ON "_auth_decompositions"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_auth_decompositions_ledger_sequence_id_idx" ON "_auth_decompositions"("ledger_sequence", "id");

-- CreateIndex
CREATE INDEX "_sanctions_lists_address_idx" ON "_sanctions_lists"("address");

-- CreateIndex
CREATE INDEX "_sanctions_lists_source_list_version_idx" ON "_sanctions_lists"("source", "list_version");

-- CreateIndex
CREATE INDEX "_sanctions_lists_is_active_idx" ON "_sanctions_lists"("is_active");

-- CreateIndex
CREATE INDEX "_sanctions_lists_source_is_active_idx" ON "_sanctions_lists"("source", "is_active");

-- CreateIndex
CREATE INDEX "_sanctions_lists_name_idx" ON "_sanctions_lists"("name");

-- CreateIndex
CREATE INDEX "_screening_results_address_idx" ON "_screening_results"("address");

-- CreateIndex
CREATE INDEX "_screening_results_tx_hash_idx" ON "_screening_results"("tx_hash");

-- CreateIndex
CREATE INDEX "_screening_results_screened_at_idx" ON "_screening_results"("screened_at" DESC);

-- CreateIndex
CREATE INDEX "_screening_results_status_idx" ON "_screening_results"("status");

-- CreateIndex
CREATE INDEX "_screening_results_risk_score_idx" ON "_screening_results"("risk_score");

-- CreateIndex
CREATE INDEX "_screening_results_address_status_idx" ON "_screening_results"("address", "status");

-- CreateIndex
CREATE UNIQUE INDEX "_travel_rule_records_tx_hash_key" ON "_travel_rule_records"("tx_hash");

-- CreateIndex
CREATE INDEX "_travel_rule_records_tx_hash_idx" ON "_travel_rule_records"("tx_hash");

-- CreateIndex
CREATE INDEX "_travel_rule_records_travel_rule_status_idx" ON "_travel_rule_records"("travel_rule_status");

-- CreateIndex
CREATE INDEX "_travel_rule_records_submitted_at_idx" ON "_travel_rule_records"("submitted_at");

-- CreateIndex
CREATE INDEX "_compliance_reports_report_type_period_start_idx" ON "_compliance_reports"("report_type", "period_start" DESC);

-- CreateIndex
CREATE INDEX "_compliance_reports_generated_at_idx" ON "_compliance_reports"("generated_at" DESC);

-- CreateIndex
CREATE INDEX "_contract_resource_metrics_contract_address_idx" ON "_contract_resource_metrics"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_resource_metrics_ledger_sequence_idx" ON "_contract_resource_metrics"("ledger_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "_contract_resource_metrics_contract_address_transaction_has_key" ON "_contract_resource_metrics"("contract_address", "transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_translation_keies_key_key" ON "_translation_keies"("key");

-- CreateIndex
CREATE INDEX "_translation_keies_key_idx" ON "_translation_keies"("key");

-- CreateIndex
CREATE INDEX "_translations_key_id_idx" ON "_translations"("key_id");

-- CreateIndex
CREATE INDEX "_translations_language_idx" ON "_translations"("language");

-- CreateIndex
CREATE UNIQUE INDEX "_translations_key_id_language_key" ON "_translations"("key_id", "language");

-- CreateIndex
CREATE UNIQUE INDEX "_feed_channels_name_key" ON "_feed_channels"("name");

-- CreateIndex
CREATE INDEX "_feed_messages_channel_name_idx" ON "_feed_messages"("channel_name");

-- CreateIndex
CREATE INDEX "_feed_messages_ledger_sequence_idx" ON "_feed_messages"("ledger_sequence");

-- CreateIndex
CREATE INDEX "_feed_subscriptions_channel_name_idx" ON "_feed_subscriptions"("channel_name");

-- CreateIndex
CREATE INDEX "_feed_subscriptions_status_idx" ON "_feed_subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "_emergency_states_contract_address_key" ON "_emergency_states"("contract_address");

-- CreateIndex
CREATE INDEX "_emergency_states_contract_address_idx" ON "_emergency_states"("contract_address");

-- CreateIndex
CREATE INDEX "_pause_events_contract_address_idx" ON "_pause_events"("contract_address");

-- CreateIndex
CREATE INDEX "_pause_events_event_type_idx" ON "_pause_events"("event_type");

-- CreateIndex
CREATE INDEX "_pause_events_timestamp_idx" ON "_pause_events"("timestamp");

-- CreateIndex
CREATE INDEX "_pause_events_pauser_address_idx" ON "_pause_events"("pauser_address");

-- CreateIndex
CREATE INDEX "_pause_events_contract_address_timestamp_idx" ON "_pause_events"("contract_address", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_pauser_analysis_contract_address_key" ON "_pauser_analysis"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "_recovery_analysis_contract_address_key" ON "_recovery_analysis"("contract_address");

-- CreateIndex
CREATE INDEX "_alert_configurations_user_id_idx" ON "_alert_configurations"("user_id");

-- CreateIndex
CREATE INDEX "_alert_configurations_contract_address_idx" ON "_alert_configurations"("contract_address");

-- CreateIndex
CREATE INDEX "_alert_configurations_alert_type_is_active_idx" ON "_alert_configurations"("alert_type", "is_active");

-- CreateIndex
CREATE INDEX "_incident_reports_contract_address_idx" ON "_incident_reports"("contract_address");

-- CreateIndex
CREATE INDEX "_incident_reports_status_idx" ON "_incident_reports"("status");

-- CreateIndex
CREATE INDEX "_incident_reports_severity_idx" ON "_incident_reports"("severity");

-- CreateIndex
CREATE INDEX "_incident_reports_created_at_idx" ON "_incident_reports"("created_at");

-- CreateIndex
CREATE INDEX "_incident_comments_incident_id_idx" ON "_incident_comments"("incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "_protocol_health_scores_contract_address_key" ON "_protocol_health_scores"("contract_address");

-- CreateIndex
CREATE INDEX "_protocol_health_scores_health_score_idx" ON "_protocol_health_scores"("health_score");

-- CreateIndex
CREATE UNIQUE INDEX "_stellar_accounts_address_key" ON "_stellar_accounts"("address");

-- CreateIndex
CREATE INDEX "_stellar_accounts_last_activity_idx" ON "_stellar_accounts"("last_activity");

-- CreateIndex
CREATE UNIQUE INDEX "_account_trustlines_account_id_asset_code_asset_issuer_key" ON "_account_trustlines"("account_id", "asset_code", "asset_issuer");

-- CreateIndex
CREATE UNIQUE INDEX "_account_signers_account_id_signer_key_key" ON "_account_signers"("account_id", "signer_key");

-- CreateIndex
CREATE UNIQUE INDEX "_stellar_assets_asset_code_asset_issuer_key" ON "_stellar_assets"("asset_code", "asset_issuer");

-- CreateIndex
CREATE INDEX "_unified_transactions_source_account_created_at_idx" ON "_unified_transactions"("source_account", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "_unified_transactions_network_tx_hash_key" ON "_unified_transactions"("network", "tx_hash");

-- CreateIndex
CREATE INDEX "_anchors_registries_home_domain_idx" ON "_anchors_registries"("home_domain");

-- CreateIndex
CREATE INDEX "_anchors_registries_status_idx" ON "_anchors_registries"("status");

-- CreateIndex
CREATE INDEX "_anchor_reviews_anchor_id_idx" ON "_anchor_reviews"("anchor_id");

-- CreateIndex
CREATE UNIQUE INDEX "_bridged_assets_soroban_contract_key" ON "_bridged_assets"("soroban_contract");

-- CreateIndex
CREATE UNIQUE INDEX "_composed_transactions_tx_hash_key" ON "_composed_transactions"("tx_hash");

-- CreateIndex
CREATE INDEX "_composed_transactions_ledger_seq_idx" ON "_composed_transactions"("ledger_seq");

-- CreateIndex
CREATE INDEX "_composed_transactions_risk_level_idx" ON "_composed_transactions"("risk_level");

-- CreateIndex
CREATE INDEX "_composed_transactions_analysis_status_idx" ON "_composed_transactions"("analysis_status");

-- CreateIndex
CREATE UNIQUE INDEX "_composition_patterns_name_key" ON "_composition_patterns"("name");

-- CreateIndex
CREATE INDEX "_composition_patterns_category_idx" ON "_composition_patterns"("category");

-- CreateIndex
CREATE INDEX "_composition_patterns_risk_rating_idx" ON "_composition_patterns"("risk_rating");

-- CreateIndex
CREATE INDEX "_composition_pattern_instances_tx_id_idx" ON "_composition_pattern_instances"("tx_id");

-- CreateIndex
CREATE INDEX "_composition_pattern_instances_pattern_id_idx" ON "_composition_pattern_instances"("pattern_id");

-- CreateIndex
CREATE UNIQUE INDEX "_contract_composabilities_contract_address_key" ON "_contract_composabilities"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_composabilities_contract_address_idx" ON "_contract_composabilities"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_composabilities_risk_incidents_idx" ON "_contract_composabilities"("risk_incidents");

-- CreateIndex
CREATE INDEX "_composition_alerts_tx_hash_idx" ON "_composition_alerts"("tx_hash");

-- CreateIndex
CREATE INDEX "_composition_alerts_contract_address_idx" ON "_composition_alerts"("contract_address");

-- CreateIndex
CREATE INDEX "_composition_alerts_severity_idx" ON "_composition_alerts"("severity");

-- CreateIndex
CREATE INDEX "_composition_alerts_exploit_detected_idx" ON "_composition_alerts"("exploit_detected");

-- CreateIndex
CREATE UNIQUE INDEX "_composability_static_analysis_contract_address_key" ON "_composability_static_analysis"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "_composability_verifications_tx_hash_key" ON "_composability_verifications"("tx_hash");

-- CreateIndex
CREATE INDEX "_composability_verifications_verified_idx" ON "_composability_verifications"("verified");

-- CreateIndex
CREATE INDEX "_composability_fuzz_campaigns_contract_address_idx" ON "_composability_fuzz_campaigns"("contract_address");

-- CreateIndex
CREATE INDEX "_composability_fuzz_campaigns_status_idx" ON "_composability_fuzz_campaigns"("status");

-- CreateIndex
CREATE INDEX "_composability_exploits_pattern_category_idx" ON "_composability_exploits"("pattern_category");

-- CreateIndex
CREATE INDEX "_composability_exploits_severity_idx" ON "_composability_exploits"("severity");

-- CreateIndex
CREATE INDEX "_ecosystem_composability_indexes_computed_at_idx" ON "_ecosystem_composability_indexes"("computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "_mev_victims_address_key" ON "_mev_victims"("address");

-- CreateIndex
CREATE INDEX "_mev_victims_address_idx" ON "_mev_victims"("address");

-- CreateIndex
CREATE UNIQUE INDEX "_mev_attackers_address_key" ON "_mev_attackers"("address");

-- CreateIndex
CREATE INDEX "_mev_attackers_address_idx" ON "_mev_attackers"("address");

-- CreateIndex
CREATE INDEX "_mev_attackers_total_profit_usd_idx" ON "_mev_attackers"("total_profit_usd");

-- CreateIndex
CREATE UNIQUE INDEX "_mev_events_tx_hash_key" ON "_mev_events"("tx_hash");

-- CreateIndex
CREATE INDEX "_mev_events_mev_type_idx" ON "_mev_events"("mev_type");

-- CreateIndex
CREATE INDEX "_mev_events_ledger_seq_idx" ON "_mev_events"("ledger_seq");

-- CreateIndex
CREATE INDEX "_mev_events_victim_address_idx" ON "_mev_events"("victim_address");

-- CreateIndex
CREATE INDEX "_mev_events_attacker_address_idx" ON "_mev_events"("attacker_address");

-- CreateIndex
CREATE INDEX "_mev_events_protocol_address_idx" ON "_mev_events"("protocol_address");

-- CreateIndex
CREATE INDEX "_mev_events_created_at_idx" ON "_mev_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "_protocol_mev_resistances_contract_address_key" ON "_protocol_mev_resistances"("contract_address");

-- CreateIndex
CREATE INDEX "_protocol_mev_resistances_contract_address_idx" ON "_protocol_mev_resistances"("contract_address");

-- CreateIndex
CREATE INDEX "_protocol_mev_resistances_score_idx" ON "_protocol_mev_resistances"("score");

-- CreateIndex
CREATE INDEX "_mev_alerts_alert_type_idx" ON "_mev_alerts"("alert_type");

-- CreateIndex
CREATE INDEX "_mev_alerts_severity_idx" ON "_mev_alerts"("severity");

-- CreateIndex
CREATE INDEX "_mev_alerts_victim_address_idx" ON "_mev_alerts"("victim_address");

-- CreateIndex
CREATE INDEX "_mev_alerts_acknowledged_idx" ON "_mev_alerts"("acknowledged");

-- CreateIndex
CREATE INDEX "_mev_alerts_created_at_idx" ON "_mev_alerts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "_billing_plans_name_key" ON "_billing_plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "_developers_email_key" ON "_developers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "_developers_github_id_key" ON "_developers"("github_id");

-- CreateIndex
CREATE INDEX "_developers_email_idx" ON "_developers"("email");

-- CreateIndex
CREATE INDEX "_developers_plan_id_idx" ON "_developers"("plan_id");

-- CreateIndex
CREATE INDEX "_dev_api_keies_developer_id_idx" ON "_dev_api_keies"("developer_id");

-- CreateIndex
CREATE INDEX "_dev_api_keies_key_prefix_idx" ON "_dev_api_keies"("key_prefix");

-- CreateIndex
CREATE INDEX "_dev_api_keies_key_hash_idx" ON "_dev_api_keies"("key_hash");

-- CreateIndex
CREATE INDEX "_dev_api_keies_status_idx" ON "_dev_api_keies"("status");

-- CreateIndex
CREATE INDEX "_dev_api_keies_tier_idx" ON "_dev_api_keies"("tier");

-- CreateIndex
CREATE INDEX "_dev_api_keies_expires_at_idx" ON "_dev_api_keies"("expires_at");

-- CreateIndex
CREATE INDEX "_key_rotation_audits_developer_id_idx" ON "_key_rotation_audits"("developer_id");

-- CreateIndex
CREATE INDEX "_key_rotation_audits_old_key_id_idx" ON "_key_rotation_audits"("old_key_id");

-- CreateIndex
CREATE INDEX "_key_rotation_audits_new_key_id_idx" ON "_key_rotation_audits"("new_key_id");

-- CreateIndex
CREATE INDEX "_key_rotation_audits_rotated_at_idx" ON "_key_rotation_audits"("rotated_at");

-- CreateIndex
CREATE INDEX "_dev_webhooks_developer_id_idx" ON "_dev_webhooks"("developer_id");

-- CreateIndex
CREATE INDEX "_dev_webhook_deliveries_webhook_id_idx" ON "_dev_webhook_deliveries"("webhook_id");

-- CreateIndex
CREATE INDEX "_dev_webhook_deliveries_delivered_idx" ON "_dev_webhook_deliveries"("delivered");

-- CreateIndex
CREATE INDEX "_dev_webhook_deliveries_expires_at_idx" ON "_dev_webhook_deliveries"("expires_at");

-- CreateIndex
CREATE INDEX "_usage_records_developer_id_idx" ON "_usage_records"("developer_id");

-- CreateIndex
CREATE INDEX "_usage_records_api_key_id_idx" ON "_usage_records"("api_key_id");

-- CreateIndex
CREATE INDEX "_usage_records_created_at_idx" ON "_usage_records"("created_at");

-- CreateIndex
CREATE INDEX "_usage_records_endpoint_idx" ON "_usage_records"("endpoint");

-- CreateIndex
CREATE INDEX "_scheduled_operations_contract_address_idx" ON "_scheduled_operations"("contract_address");

-- CreateIndex
CREATE INDEX "_scheduled_operations_timer_type_idx" ON "_scheduled_operations"("timer_type");

-- CreateIndex
CREATE INDEX "_scheduled_operations_status_idx" ON "_scheduled_operations"("status");

-- CreateIndex
CREATE INDEX "_scheduled_operations_next_trigger_at_idx" ON "_scheduled_operations"("next_trigger_at");

-- CreateIndex
CREATE INDEX "_scheduled_operations_trigger_time_idx" ON "_scheduled_operations"("trigger_time");

-- CreateIndex
CREATE INDEX "_vesting_schedules_beneficiary_idx" ON "_vesting_schedules"("beneficiary");

-- CreateIndex
CREATE INDEX "_vesting_schedules_contract_address_idx" ON "_vesting_schedules"("contract_address");

-- CreateIndex
CREATE INDEX "_vesting_schedules_next_unlock_date_idx" ON "_vesting_schedules"("next_unlock_date");

-- CreateIndex
CREATE INDEX "_vesting_schedules_status_idx" ON "_vesting_schedules"("status");

-- CreateIndex
CREATE INDEX "_governance_timelocks_contract_address_idx" ON "_governance_timelocks"("contract_address");

-- CreateIndex
CREATE INDEX "_governance_timelocks_proposal_id_idx" ON "_governance_timelocks"("proposal_id");

-- CreateIndex
CREATE INDEX "_governance_timelocks_status_idx" ON "_governance_timelocks"("status");

-- CreateIndex
CREATE INDEX "_governance_timelocks_execution_time_idx" ON "_governance_timelocks"("execution_time");

-- CreateIndex
CREATE INDEX "_cron_jobs_contract_address_idx" ON "_cron_jobs"("contract_address");

-- CreateIndex
CREATE INDEX "_cron_jobs_next_run_at_idx" ON "_cron_jobs"("next_run_at");

-- CreateIndex
CREATE INDEX "_cron_executions_cron_job_id_executed_at_idx" ON "_cron_executions"("cron_job_id", "executed_at");

-- CreateIndex
CREATE INDEX "_timer_alerts_scheduled_op_id_idx" ON "_timer_alerts"("scheduled_op_id");

-- CreateIndex
CREATE INDEX "_timer_alerts_trigger_time_idx" ON "_timer_alerts"("trigger_time");

-- CreateIndex
CREATE INDEX "_price_deviations_token_a_token_b_timestamp_idx" ON "_price_deviations"("token_a", "token_b", "timestamp");

-- CreateIndex
CREATE INDEX "_price_deviations_deviation_percentage_idx" ON "_price_deviations"("deviation_percentage");

-- CreateIndex
CREATE INDEX "_price_deviations_timestamp_idx" ON "_price_deviations"("timestamp");

-- CreateIndex
CREATE INDEX "_price_deviations_pool_id_a_idx" ON "_price_deviations"("pool_id_a");

-- CreateIndex
CREATE INDEX "_price_deviations_pool_id_b_idx" ON "_price_deviations"("pool_id_b");

-- CreateIndex
CREATE INDEX "_arbitrage_opportunities_status_detected_at_idx" ON "_arbitrage_opportunities"("status", "detected_at");

-- CreateIndex
CREATE INDEX "_arbitrage_opportunities_pair_status_idx" ON "_arbitrage_opportunities"("pair", "status");

-- CreateIndex
CREATE INDEX "_arbitrage_opportunities_type_idx" ON "_arbitrage_opportunities"("type");

-- CreateIndex
CREATE INDEX "_arbitrage_opportunities_profit_percentage_idx" ON "_arbitrage_opportunities"("profit_percentage");

-- CreateIndex
CREATE INDEX "_arbitrage_opportunities_detected_at_idx" ON "_arbitrage_opportunities"("detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "_mev_opportunity_scores_opportunity_id_key" ON "_mev_opportunity_scores"("opportunity_id");

-- CreateIndex
CREATE INDEX "_mev_opportunity_scores_overall_score_idx" ON "_mev_opportunity_scores"("overall_score");

-- CreateIndex
CREATE INDEX "_mev_opportunity_scores_recommendation_idx" ON "_mev_opportunity_scores"("recommendation");

-- CreateIndex
CREATE INDEX "_arbitrage_executions_opportunity_id_idx" ON "_arbitrage_executions"("opportunity_id");

-- CreateIndex
CREATE INDEX "_arbitrage_executions_searcher_address_idx" ON "_arbitrage_executions"("searcher_address");

-- CreateIndex
CREATE INDEX "_arbitrage_executions_success_idx" ON "_arbitrage_executions"("success");

-- CreateIndex
CREATE INDEX "_arbitrage_executions_executed_at_idx" ON "_arbitrage_executions"("executed_at");

-- CreateIndex
CREATE UNIQUE INDEX "_arbitrage_bots_address_key" ON "_arbitrage_bots"("address");

-- CreateIndex
CREATE INDEX "_arbitrage_bots_total_profit_idx" ON "_arbitrage_bots"("total_profit");

-- CreateIndex
CREATE INDEX "_arbitrage_bots_is_active_idx" ON "_arbitrage_bots"("is_active");

-- CreateIndex
CREATE INDEX "_arbitrage_bots_last_seen_idx" ON "_arbitrage_bots"("last_seen");

-- CreateIndex
CREATE INDEX "_sandwich_attacks_victim_address_idx" ON "_sandwich_attacks"("victim_address");

-- CreateIndex
CREATE INDEX "_sandwich_attacks_attacker_address_idx" ON "_sandwich_attacks"("attacker_address");

-- CreateIndex
CREATE INDEX "_sandwich_attacks_timestamp_idx" ON "_sandwich_attacks"("timestamp");

-- CreateIndex
CREATE INDEX "_sandwich_attacks_pair_idx" ON "_sandwich_attacks"("pair");

-- CreateIndex
CREATE INDEX "_arbitrage_alerts_is_active_idx" ON "_arbitrage_alerts"("is_active");

-- CreateIndex
CREATE INDEX "_pool_prices_pool_id_timestamp_idx" ON "_pool_prices"("pool_id", "timestamp");

-- CreateIndex
CREATE INDEX "_pool_prices_timestamp_idx" ON "_pool_prices"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_pool_prices_pool_id_block_number_key" ON "_pool_prices"("pool_id", "block_number");

-- CreateIndex
CREATE INDEX "_fee_events_contract_address_timestamp_idx" ON "_fee_events"("contract_address", "timestamp");

-- CreateIndex
CREATE INDEX "_fee_events_fee_type_idx" ON "_fee_events"("fee_type");

-- CreateIndex
CREATE INDEX "_fee_events_timestamp_idx" ON "_fee_events"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_fee_events_tx_hash_fee_type_destination_key" ON "_fee_events"("tx_hash", "fee_type", "destination");

-- CreateIndex
CREATE INDEX "_protocol_revenues_contract_address_period_timestamp_idx" ON "_protocol_revenues"("contract_address", "period", "timestamp");

-- CreateIndex
CREATE INDEX "_protocol_revenues_period_timestamp_idx" ON "_protocol_revenues"("period", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_protocol_revenues_contract_address_period_timestamp_key" ON "_protocol_revenues"("contract_address", "period", "timestamp");

-- CreateIndex
CREATE INDEX "_yield_snapshots_contract_address_timestamp_idx" ON "_yield_snapshots"("contract_address", "timestamp");

-- CreateIndex
CREATE INDEX "_yield_snapshots_timestamp_idx" ON "_yield_snapshots"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "_protocol_profiles_contract_address_key" ON "_protocol_profiles"("contract_address");

-- CreateIndex
CREATE INDEX "_protocol_profiles_protocol_name_idx" ON "_protocol_profiles"("protocol_name");

-- CreateIndex
CREATE INDEX "_revenue_alerts_contract_address_detected_at_idx" ON "_revenue_alerts"("contract_address", "detected_at");

-- CreateIndex
CREATE INDEX "_revenue_alerts_severity_idx" ON "_revenue_alerts"("severity");

-- CreateIndex
CREATE INDEX "_revenue_alerts_detected_at_idx" ON "_revenue_alerts"("detected_at");

-- CreateIndex
CREATE INDEX "_protocol_economics_snapshots_bucket_bucket_start_idx" ON "_protocol_economics_snapshots"("bucket", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "_protocol_economics_snapshots_bucket_bucket_start_key" ON "_protocol_economics_snapshots"("bucket", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "_feature_definitions_name_key" ON "_feature_definitions"("name");

-- CreateIndex
CREATE INDEX "_feature_definitions_category_idx" ON "_feature_definitions"("category");

-- CreateIndex
CREATE INDEX "_feature_values_feature_id_timestamp_idx" ON "_feature_values"("feature_id", "timestamp");

-- CreateIndex
CREATE INDEX "_prediction_scenarios_scenario_name_idx" ON "_prediction_scenarios"("scenario_name");

-- CreateIndex
CREATE UNIQUE INDEX "_predictive_api_keies_key_key" ON "_predictive_api_keies"("key");

-- CreateIndex
CREATE INDEX "_predictive_api_keies_key_idx" ON "_predictive_api_keies"("key");

-- CreateIndex
CREATE INDEX "_amm_pools_pool_address_idx" ON "_amm_pools"("pool_address");

-- CreateIndex
CREATE UNIQUE INDEX "_attestations_uid_key" ON "_attestations"("uid");

-- CreateIndex
CREATE INDEX "_attestations_profile_id_idx" ON "_attestations"("profile_id");

-- CreateIndex
CREATE INDEX "_attestations_chain_id_idx" ON "_attestations"("chain_id");

-- CreateIndex
CREATE INDEX "_sensitive_read_audits_actor_idx" ON "_sensitive_read_audits"("actor");

-- CreateIndex
CREATE INDEX "_sensitive_read_audits_endpoint_idx" ON "_sensitive_read_audits"("endpoint");

-- CreateIndex
CREATE INDEX "_sensitive_read_audits_target_idx" ON "_sensitive_read_audits"("target");

-- CreateIndex
CREATE INDEX "_sensitive_read_audits_created_at_idx" ON "_sensitive_read_audits"("created_at" DESC);

-- CreateIndex
CREATE INDEX "_backfill_requests_user_id_idx" ON "_backfill_requests"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "_contract_factories_parent_contract_address_child_contract__key" ON "_contract_factories"("parent_contract_address", "child_contract_address");

-- CreateIndex
CREATE INDEX "_dtcc_settlement_bridges_dtcc_settlement_id_idx" ON "_dtcc_settlement_bridges"("dtcc_settlement_id");

-- CreateIndex
CREATE INDEX "_endorsements_profile_id_idx" ON "_endorsements"("profile_id");

-- CreateIndex
CREATE INDEX "_export_jobs_developer_id_idx" ON "_export_jobs"("developer_id");

-- CreateIndex
CREATE INDEX "_export_jobs_developer_id_created_at_idx" ON "_export_jobs"("developer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "_freeze_violations_transaction_hash_key" ON "_freeze_violations"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_frozen_ledger_keies_ledger_key_key" ON "_frozen_ledger_keies"("ledger_key");

-- CreateIndex
CREATE INDEX "_fuzz_findings_fuzz_run_id_idx" ON "_fuzz_findings"("fuzz_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "_gas_analytics_snapshots_bucket_bucket_start_key" ON "_gas_analytics_snapshots"("bucket", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_contracts_contract_address_key" ON "_governance_contracts"("contract_address");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_delegates_contract_address_delegatee_key" ON "_governance_delegates"("contract_address", "delegatee");

-- CreateIndex
CREATE INDEX "_governance_delegations_contract_address_delegator_idx" ON "_governance_delegations"("contract_address", "delegator");

-- CreateIndex
CREATE INDEX "_governance_delegations_contract_address_delegatee_idx" ON "_governance_delegations"("contract_address", "delegatee");

-- CreateIndex
CREATE INDEX "_governance_delegations_revoked_at_idx" ON "_governance_delegations"("revoked_at");

-- CreateIndex
CREATE INDEX "_governance_voice_credits_contract_address_holder_idx" ON "_governance_voice_credits"("contract_address", "holder");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_voice_credits_contract_address_round_holder_key" ON "_governance_voice_credits"("contract_address", "round", "holder");

-- CreateIndex
CREATE INDEX "_governance_multisig_signers_contract_address_removed_at_idx" ON "_governance_multisig_signers"("contract_address", "removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_multisig_signers_contract_address_signer_key" ON "_governance_multisig_signers"("contract_address", "signer");

-- CreateIndex
CREATE INDEX "_governance_proposals_status_idx" ON "_governance_proposals"("status");

-- CreateIndex
CREATE INDEX "_governance_proposals_proposer_idx" ON "_governance_proposals"("proposer");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_proposals_contract_address_proposal_id_key" ON "_governance_proposals"("contract_address", "proposal_id");

-- CreateIndex
CREATE INDEX "_governance_votes_proposal_id_idx" ON "_governance_votes"("proposal_id");

-- CreateIndex
CREATE INDEX "_governance_votes_voter_idx" ON "_governance_votes"("voter");

-- CreateIndex
CREATE UNIQUE INDEX "_governance_votes_contract_address_proposal_id_voter_key" ON "_governance_votes"("contract_address", "proposal_id", "voter");

-- CreateIndex
CREATE UNIQUE INDEX "_treasury_accounts_account_address_key" ON "_treasury_accounts"("account_address");

-- CreateIndex
CREATE INDEX "_treasury_accounts_contract_address_idx" ON "_treasury_accounts"("contract_address");

-- CreateIndex
CREATE INDEX "_treasury_assets_treasury_id_idx" ON "_treasury_assets"("treasury_id");

-- CreateIndex
CREATE UNIQUE INDEX "_treasury_assets_treasury_id_asset_code_token_address_key" ON "_treasury_assets"("treasury_id", "asset_code", "token_address");

-- CreateIndex
CREATE INDEX "_treasury_payout_streams_treasury_id_idx" ON "_treasury_payout_streams"("treasury_id");

-- CreateIndex
CREATE INDEX "_treasury_payout_streams_recipient_idx" ON "_treasury_payout_streams"("recipient");

-- CreateIndex
CREATE INDEX "_treasury_payout_streams_proposal_id_idx" ON "_treasury_payout_streams"("proposal_id");

-- CreateIndex
CREATE INDEX "_treasury_transactions_treasury_id_timestamp_idx" ON "_treasury_transactions"("treasury_id", "timestamp");

-- CreateIndex
CREATE INDEX "_treasury_transactions_transaction_hash_idx" ON "_treasury_transactions"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_treasury_transactions_treasury_id_transaction_hash_asset_c_key" ON "_treasury_transactions"("treasury_id", "transaction_hash", "asset_code", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "_linked_identities_profile_id_chain_id_address_key" ON "_linked_identities"("profile_id", "chain_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "_network_nodes_public_key_key" ON "_network_nodes"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "_privacy_compliance_reports_address_key" ON "_privacy_compliance_reports"("address");

-- CreateIndex
CREATE UNIQUE INDEX "_privacy_transactions_tx_hash_key" ON "_privacy_transactions"("tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_reentrancy_alerts_transaction_hash_key" ON "_reentrancy_alerts"("transaction_hash");

-- CreateIndex
CREATE INDEX "_reputation_badges_profile_id_idx" ON "_reputation_badges"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "_reputation_governance_votes_proposal_id_voter_key" ON "_reputation_governance_votes"("proposal_id", "voter");

-- CreateIndex
CREATE UNIQUE INDEX "_reputation_profiles_address_key" ON "_reputation_profiles"("address");

-- CreateIndex
CREATE INDEX "_reputation_trust_connections_profile_id_idx" ON "_reputation_trust_connections"("profile_id");

-- CreateIndex
CREATE INDEX "_reputation_signals_profile_id_idx" ON "_reputation_signals"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "_rwa_compliance_events_transaction_hash_key" ON "_rwa_compliance_events"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_sandbox_accounts_session_id_public_key_key" ON "_sandbox_accounts"("session_id", "public_key");

-- CreateIndex
CREATE INDEX "_sandbox_calls_session_id_idx" ON "_sandbox_calls"("session_id");

-- CreateIndex
CREATE INDEX "_sandbox_calls_contract_id_idx" ON "_sandbox_calls"("contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "_sandbox_contracts_session_id_contract_id_key" ON "_sandbox_contracts"("session_id", "contract_id");

-- CreateIndex
CREATE INDEX "_sandbox_sessions_user_id_idx" ON "_sandbox_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "_sandbox_shares_share_id_key" ON "_sandbox_shares"("share_id");

-- CreateIndex
CREATE UNIQUE INDEX "_settlement_batch_summaries_contract_address_window_key_key" ON "_settlement_batch_summaries"("contract_address", "window_key");

-- CreateIndex
CREATE UNIQUE INDEX "_signature_inspections_transaction_hash_key" ON "_signature_inspections"("transaction_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_threat_advisories_cve_id_key" ON "_threat_advisories"("cve_id");

-- CreateIndex
CREATE UNIQUE INDEX "_threat_advisories_ghsa_id_key" ON "_threat_advisories"("ghsa_id");

-- CreateIndex
CREATE UNIQUE INDEX "_tip_subscriptions_channel_target_key" ON "_tip_subscriptions"("channel", "target");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_address_key" ON "tokens"("address");

-- CreateIndex
CREATE INDEX "tokens_holderCount_idx" ON "tokens"("holderCount" DESC);

-- CreateIndex
CREATE INDEX "tokens_transferCount24h_idx" ON "tokens"("transferCount24h" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "_token_prices_token_address_key" ON "_token_prices"("token_address");

-- CreateIndex
CREATE INDEX "_token_prices_updated_at_idx" ON "_token_prices"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "_token_prices_volume24h_usd_idx" ON "_token_prices"("volume24h_usd" DESC);

-- CreateIndex
CREATE INDEX "_token_price_histories_token_address_timestamp_idx" ON "_token_price_histories"("token_address", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "_token_price_histories_timestamp_idx" ON "_token_price_histories"("timestamp");

-- CreateIndex
CREATE INDEX "_price_alerts_user_id_idx" ON "_price_alerts"("user_id");

-- CreateIndex
CREATE INDEX "_price_alerts_token_address_idx" ON "_price_alerts"("token_address");

-- CreateIndex
CREATE INDEX "_verifiable_credentials_profile_id_idx" ON "_verifiable_credentials"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "_vulnerability_sources_name_key" ON "_vulnerability_sources"("name");

-- CreateIndex
CREATE INDEX "_webhook_deliveries_subscription_id_idx" ON "_webhook_deliveries"("subscription_id");

-- CreateIndex
CREATE INDEX "_webhook_deliveries_expires_at_idx" ON "_webhook_deliveries"("expires_at");

-- CreateIndex
CREATE INDEX "_webhook_deliveries_status_next_retry_at_processing_status_idx" ON "_webhook_deliveries"("status", "next_retry_at", "processing_status");

-- CreateIndex
CREATE INDEX "_webhook_subscriptions_api_key_id_idx" ON "_webhook_subscriptions"("api_key_id");

-- CreateIndex
CREATE INDEX "_yield_history_snapshots_opportunity_id_idx" ON "_yield_history_snapshots"("opportunity_id");

-- CreateIndex
CREATE INDEX "call_graph_vertices_tx_hash_idx" ON "call_graph_vertices"("tx_hash");

-- CreateIndex
CREATE INDEX "call_graph_vertices_contract_address_idx" ON "call_graph_vertices"("contract_address");

-- CreateIndex
CREATE INDEX "call_graph_edges_tx_hash_idx" ON "call_graph_edges"("tx_hash");

-- CreateIndex
CREATE INDEX "call_graph_edges_from_vertex_id_idx" ON "call_graph_edges"("from_vertex_id");

-- CreateIndex
CREATE INDEX "call_graph_edges_to_vertex_id_idx" ON "call_graph_edges"("to_vertex_id");

-- CreateIndex
CREATE INDEX "reentrancy_findings_tx_hash_idx" ON "reentrancy_findings"("tx_hash");

-- CreateIndex
CREATE INDEX "reentrancy_findings_contract_address_idx" ON "reentrancy_findings"("contract_address");

-- CreateIndex
CREATE INDEX "reentrancy_findings_severity_idx" ON "reentrancy_findings"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "contract_risk_scores_contract_address_key" ON "contract_risk_scores"("contract_address");

-- CreateIndex
CREATE INDEX "reentrancy_alerts_contract_address_created_at_idx" ON "reentrancy_alerts"("contract_address", "created_at" DESC);

-- CreateIndex
CREATE INDEX "nl_queries_userId_createdAt_idx" ON "nl_queries"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "nl_queries_createdAt_idx" ON "nl_queries"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "nl_query_contexts_query_id_key" ON "nl_query_contexts"("query_id");

-- CreateIndex
CREATE INDEX "nl_query_contexts_session_id_idx" ON "nl_query_contexts"("session_id");

-- CreateIndex
CREATE INDEX "nl_sessions_userId_idx" ON "nl_sessions"("userId");

-- CreateIndex
CREATE INDEX "saved_queries_userId_idx" ON "saved_queries"("userId");

-- CreateIndex
CREATE INDEX "saved_queries_query_id_idx" ON "saved_queries"("query_id");

-- CreateIndex
CREATE UNIQUE INDEX "nl_embeddings_query_key" ON "nl_embeddings"("query");

-- CreateIndex
CREATE INDEX "nl_query_templates_is_public_idx" ON "nl_query_templates"("is_public");

-- CreateIndex
CREATE INDEX "nl_query_templates_category_idx" ON "nl_query_templates"("category");

-- CreateIndex
CREATE INDEX "nl_reports_userId_idx" ON "nl_reports"("userId");

-- CreateIndex
CREATE INDEX "nl_report_history_report_id_ran_at_idx" ON "nl_report_history"("report_id", "ran_at" DESC);

-- CreateIndex
CREATE INDEX "nl_alerts_userId_idx" ON "nl_alerts"("userId");

-- CreateIndex
CREATE INDEX "nl_alerts_active_idx" ON "nl_alerts"("active");

-- CreateIndex
CREATE UNIQUE INDEX "archival_nodes_address_key" ON "archival_nodes"("address");

-- CreateIndex
CREATE INDEX "archival_nodes_status_idx" ON "archival_nodes"("status");

-- CreateIndex
CREATE INDEX "archival_nodes_reputation_idx" ON "archival_nodes"("reputation");

-- CreateIndex
CREATE INDEX "archival_epochs_nodeId_idx" ON "archival_epochs"("nodeId");

-- CreateIndex
CREATE INDEX "archival_epochs_epochId_idx" ON "archival_epochs"("epochId");

-- CreateIndex
CREATE INDEX "archival_epochs_status_idx" ON "archival_epochs"("status");

-- CreateIndex
CREATE INDEX "storage_challenges_nodeId_idx" ON "storage_challenges"("nodeId");

-- CreateIndex
CREATE INDEX "storage_challenges_epochId_idx" ON "storage_challenges"("epochId");

-- CreateIndex
CREATE INDEX "storage_challenges_status_idx" ON "storage_challenges"("status");

-- CreateIndex
CREATE INDEX "data_retrievals_requester_idx" ON "data_retrievals"("requester");

-- CreateIndex
CREATE INDEX "data_retrievals_epochId_idx" ON "data_retrievals"("epochId");

-- CreateIndex
CREATE INDEX "data_retrievals_nodeId_idx" ON "data_retrievals"("nodeId");

-- CreateIndex
CREATE INDEX "data_retrievals_status_idx" ON "data_retrievals"("status");

-- CreateIndex
CREATE INDEX "sla_offers_nodeId_idx" ON "sla_offers"("nodeId");

-- CreateIndex
CREATE INDEX "sla_offers_tier_idx" ON "sla_offers"("tier");

-- CreateIndex
CREATE INDEX "sla_acceptances_offerId_idx" ON "sla_acceptances"("offerId");

-- CreateIndex
CREATE INDEX "sla_acceptances_requester_idx" ON "sla_acceptances"("requester");

-- CreateIndex
CREATE INDEX "archival_slashes_nodeId_idx" ON "archival_slashes"("nodeId");

-- CreateIndex
CREATE INDEX "archival_slashes_challengeId_idx" ON "archival_slashes"("challengeId");

-- CreateIndex
CREATE INDEX "archival_appeals_slashId_idx" ON "archival_appeals"("slashId");

-- CreateIndex
CREATE UNIQUE INDEX "_nft_collections_contract_address_key" ON "_nft_collections"("contract_address");

-- CreateIndex
CREATE INDEX "_nft_collections_volume24h_idx" ON "_nft_collections"("volume24h" DESC);

-- CreateIndex
CREATE INDEX "_nft_collections_volume7d_idx" ON "_nft_collections"("volume7d" DESC);

-- CreateIndex
CREATE INDEX "_nft_collections_unique_holders_idx" ON "_nft_collections"("unique_holders" DESC);

-- CreateIndex
CREATE INDEX "_nft_collections_market_cap_idx" ON "_nft_collections"("market_cap" DESC);

-- CreateIndex
CREATE INDEX "_nft_collections_floor_price_idx" ON "_nft_collections"("floor_price" DESC);

-- CreateIndex
CREATE INDEX "_nft_collections_category_idx" ON "_nft_collections"("category");

-- CreateIndex
CREATE INDEX "_nft_items_owner_idx" ON "_nft_items"("owner");

-- CreateIndex
CREATE INDEX "_nft_items_rarity_score_idx" ON "_nft_items"("rarity_score" DESC);

-- CreateIndex
CREATE INDEX "_nft_items_last_sale_at_idx" ON "_nft_items"("last_sale_at" DESC);

-- CreateIndex
CREATE INDEX "_nft_items_collection_id_idx" ON "_nft_items"("collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "_nft_items_collection_id_token_id_key" ON "_nft_items"("collection_id", "token_id");

-- CreateIndex
CREATE INDEX "_nft_traits_collection_id_idx" ON "_nft_traits"("collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "_nft_traits_collection_id_trait_type_trait_value_key" ON "_nft_traits"("collection_id", "trait_type", "trait_value");

-- CreateIndex
CREATE UNIQUE INDEX "_nft_sales_tx_hash_key" ON "_nft_sales"("tx_hash");

-- CreateIndex
CREATE INDEX "_nft_sales_collection_id_sale_at_idx" ON "_nft_sales"("collection_id", "sale_at");

-- CreateIndex
CREATE INDEX "_nft_sales_seller_idx" ON "_nft_sales"("seller");

-- CreateIndex
CREATE INDEX "_nft_sales_buyer_idx" ON "_nft_sales"("buyer");

-- CreateIndex
CREATE INDEX "_nft_sales_is_wash_trade_idx" ON "_nft_sales"("is_wash_trade");

-- CreateIndex
CREATE INDEX "_nft_listings_collection_id_status_idx" ON "_nft_listings"("collection_id", "status");

-- CreateIndex
CREATE INDEX "_nft_listings_seller_idx" ON "_nft_listings"("seller");

-- CreateIndex
CREATE INDEX "_nft_collection_stats_collection_id_timestamp_idx" ON "_nft_collection_stats"("collection_id", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "_nft_collection_stats_collection_id_timestamp_key" ON "_nft_collection_stats"("collection_id", "timestamp");

-- CreateIndex
CREATE INDEX "_nft_portfolios_user_id_idx" ON "_nft_portfolios"("user_id");

-- CreateIndex
CREATE INDEX "_nft_portfolios_owner_idx" ON "_nft_portfolios"("owner");

-- CreateIndex
CREATE INDEX "_nft_activities_collection_id_occurred_at_idx" ON "_nft_activities"("collection_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "_nft_activities_activity_type_occurred_at_idx" ON "_nft_activities"("activity_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "_nft_activities_tx_hash_idx" ON "_nft_activities"("tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "_nft_marketplaces_contract_address_key" ON "_nft_marketplaces"("contract_address");

-- CreateIndex
CREATE INDEX "_nft_marketplaces_is_active_idx" ON "_nft_marketplaces"("is_active");

-- CreateIndex
CREATE INDEX "_api_audit_logs_api_key_id_idx" ON "_api_audit_logs"("api_key_id");

-- CreateIndex
CREATE INDEX "_api_audit_logs_ip_idx" ON "_api_audit_logs"("ip");

-- CreateIndex
CREATE INDEX "_api_audit_logs_created_at_idx" ON "_api_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "_api_audit_logs_endpoint_idx" ON "_api_audit_logs"("endpoint");

-- CreateIndex
CREATE INDEX "_api_audit_logs_is_rate_limited_idx" ON "_api_audit_logs"("is_rate_limited");

-- CreateIndex
CREATE INDEX "_abuse_events_ip_idx" ON "_abuse_events"("ip");

-- CreateIndex
CREATE INDEX "_abuse_events_api_key_id_idx" ON "_abuse_events"("api_key_id");

-- CreateIndex
CREATE INDEX "_abuse_events_pattern_idx" ON "_abuse_events"("pattern");

-- CreateIndex
CREATE INDEX "_abuse_events_created_at_idx" ON "_abuse_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "_abuse_events_blocked_until_idx" ON "_abuse_events"("blocked_until");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_transactions_transactionHash_key" ON "bridge_transactions"("transactionHash");

-- CreateIndex
CREATE INDEX "bridge_transactions_protocol_idx" ON "bridge_transactions"("protocol");

-- CreateIndex
CREATE INDEX "bridge_transactions_sourceChain_idx" ON "bridge_transactions"("sourceChain");

-- CreateIndex
CREATE INDEX "bridge_transactions_destinationChain_idx" ON "bridge_transactions"("destinationChain");

-- CreateIndex
CREATE INDEX "bridge_transactions_status_idx" ON "bridge_transactions"("status");

-- CreateIndex
CREATE INDEX "bridge_transactions_sender_idx" ON "bridge_transactions"("sender");

-- CreateIndex
CREATE INDEX "bridge_transactions_recipient_idx" ON "bridge_transactions"("recipient");

-- CreateIndex
CREATE INDEX "bridge_transactions_createdAt_idx" ON "bridge_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "bridge_alerts_type_idx" ON "bridge_alerts"("type");

-- CreateIndex
CREATE INDEX "bridge_alerts_severity_idx" ON "bridge_alerts"("severity");

-- CreateIndex
CREATE INDEX "bridge_alerts_address_idx" ON "bridge_alerts"("address");

-- CreateIndex
CREATE INDEX "bridge_alerts_triggeredAt_idx" ON "bridge_alerts"("triggeredAt");

-- CreateIndex
CREATE INDEX "contract_dependencies_targetAddress_isActive_idx" ON "contract_dependencies"("targetAddress", "isActive");

-- CreateIndex
CREATE INDEX "contract_dependencies_sourceAddress_isActive_idx" ON "contract_dependencies"("sourceAddress", "isActive");

-- CreateIndex
CREATE INDEX "contract_dependencies_targetAddress_idx" ON "contract_dependencies"("targetAddress");

-- CreateIndex
CREATE INDEX "contract_dependencies_sourceAddress_idx" ON "contract_dependencies"("sourceAddress");

-- CreateIndex
CREATE INDEX "bridge_volumes_protocol_period_idx" ON "bridge_volumes"("protocol", "period");

-- CreateIndex
CREATE INDEX "bridge_volumes_chain_period_idx" ON "bridge_volumes"("chain", "period");

-- CreateIndex
CREATE INDEX "bridge_volumes_periodStart_idx" ON "bridge_volumes"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_volumes_protocol_chain_asset_period_periodStart_key" ON "bridge_volumes"("protocol", "chain", "asset", "period", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_users_address_key" ON "wallet_users"("address");

-- CreateIndex
CREATE INDEX "wallet_users_address_idx" ON "wallet_users"("address");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX "auth_sessions_tokenHash_idx" ON "auth_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_refreshTokenHash_idx" ON "auth_sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "auth_events_userId_idx" ON "auth_events"("userId");

-- CreateIndex
CREATE INDEX "auth_events_eventType_idx" ON "auth_events"("eventType");

-- CreateIndex
CREATE INDEX "auth_events_createdAt_idx" ON "auth_events"("createdAt");

-- CreateIndex
CREATE INDEX "auth_webhooks_userId_idx" ON "auth_webhooks"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "multisig_wallets_walletAddress_key" ON "multisig_wallets"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_apps_clientId_key" ON "oauth_apps"("clientId");

-- CreateIndex
CREATE INDEX "oauth_apps_ownerId_idx" ON "oauth_apps"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_codes_code_key" ON "oauth_codes"("code");

-- CreateIndex
CREATE INDEX "oauth_codes_clientId_idx" ON "oauth_codes"("clientId");

-- CreateIndex
CREATE INDEX "oauth_codes_userId_idx" ON "oauth_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wasm_abi_extracts_contractAddress_key" ON "wasm_abi_extracts"("contractAddress");

-- CreateIndex
CREATE INDEX "wasm_abi_extracts_contractAddress_idx" ON "wasm_abi_extracts"("contractAddress");

-- CreateIndex
CREATE INDEX "wasm_abi_extracts_source_idx" ON "wasm_abi_extracts"("source");

-- CreateIndex
CREATE INDEX "abi_coverage_reports_contractAddress_idx" ON "abi_coverage_reports"("contractAddress");

-- CreateIndex
CREATE INDEX "abi_coverage_reports_createdAt_idx" ON "abi_coverage_reports"("createdAt");

-- CreateIndex
CREATE INDEX "abi_community_contributions_address_idx" ON "abi_community_contributions"("address");

-- CreateIndex
CREATE UNIQUE INDEX "ramp_kyc_records_userId_key" ON "ramp_kyc_records"("userId");

-- CreateIndex
CREATE INDEX "ramp_kyc_records_status_idx" ON "ramp_kyc_records"("status");

-- CreateIndex
CREATE INDEX "ramp_kyc_records_tier_idx" ON "ramp_kyc_records"("tier");

-- CreateIndex
CREATE INDEX "ramp_kyc_records_jurisdiction_idx" ON "ramp_kyc_records"("jurisdiction");

-- CreateIndex
CREATE INDEX "ramp_orders_userId_idx" ON "ramp_orders"("userId");

-- CreateIndex
CREATE INDEX "ramp_orders_status_idx" ON "ramp_orders"("status");

-- CreateIndex
CREATE INDEX "ramp_orders_provider_idx" ON "ramp_orders"("provider");

-- CreateIndex
CREATE INDEX "ramp_orders_providerOrderId_idx" ON "ramp_orders"("providerOrderId");

-- CreateIndex
CREATE INDEX "ramp_orders_direction_idx" ON "ramp_orders"("direction");

-- CreateIndex
CREATE INDEX "ramp_orders_createdAt_idx" ON "ramp_orders"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ramp_orders_userId_status_idx" ON "ramp_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "ramp_order_events_orderId_idx" ON "ramp_order_events"("orderId");

-- CreateIndex
CREATE INDEX "ramp_order_events_createdAt_idx" ON "ramp_order_events"("createdAt");

-- CreateIndex
CREATE INDEX "ramp_reconciliations_status_idx" ON "ramp_reconciliations"("status");

-- CreateIndex
CREATE INDEX "ramp_reconciliations_provider_idx" ON "ramp_reconciliations"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ramp_reconciliations_provider_periodDate_key" ON "ramp_reconciliations"("provider", "periodDate");

-- CreateIndex
CREATE INDEX "ramp_aml_flags_userId_idx" ON "ramp_aml_flags"("userId");

-- CreateIndex
CREATE INDEX "ramp_aml_flags_orderId_idx" ON "ramp_aml_flags"("orderId");

-- CreateIndex
CREATE INDEX "ramp_aml_flags_flagType_idx" ON "ramp_aml_flags"("flagType");

-- CreateIndex
CREATE INDEX "ramp_aml_flags_resolved_idx" ON "ramp_aml_flags"("resolved");

-- CreateIndex
CREATE INDEX "ramp_aml_flags_createdAt_idx" ON "ramp_aml_flags"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "fraud_alerts_transaction_hash_idx" ON "fraud_alerts"("transaction_hash");

-- CreateIndex
CREATE INDEX "fraud_alerts_target_address_idx" ON "fraud_alerts"("target_address");

-- CreateIndex
CREATE INDEX "fraud_alerts_severity_idx" ON "fraud_alerts"("severity");

-- CreateIndex
CREATE INDEX "fraud_alerts_alert_type_idx" ON "fraud_alerts"("alert_type");

-- CreateIndex
CREATE UNIQUE INDEX "fraud_feature_store_entity_id_key" ON "fraud_feature_store"("entity_id");

-- CreateIndex
CREATE INDEX "fraud_feature_store_entity_id_idx" ON "fraud_feature_store"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "fraud_model_registry_name_version_key" ON "fraud_model_registry"("name", "version");

-- CreateIndex
CREATE INDEX "fraud_model_drift_model_id_idx" ON "fraud_model_drift"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "_contract_sources_contract_address_key" ON "_contract_sources"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_sources_contract_address_idx" ON "_contract_sources"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_source_function_details_contract_address_idx" ON "_contract_source_function_details"("contract_address");

-- CreateIndex
CREATE INDEX "_contract_source_function_details_name_idx" ON "_contract_source_function_details"("name");

-- CreateIndex
CREATE INDEX "_search_index_entries_contract_address_idx" ON "_search_index_entries"("contract_address");

-- CreateIndex
CREATE INDEX "_search_index_entries_content_type_idx" ON "_search_index_entries"("content_type");

-- CreateIndex
CREATE INDEX "_search_index_entries_content_idx" ON "_search_index_entries"("content");

-- CreateIndex
CREATE UNIQUE INDEX "_feature_flags_key_key" ON "_feature_flags"("key");

-- CreateIndex
CREATE INDEX "_feature_flag_overrides_flag_key_scope_type_idx" ON "_feature_flag_overrides"("flag_key", "scope_type");

-- CreateIndex
CREATE UNIQUE INDEX "_feature_flag_overrides_flag_key_scope_type_scope_value_key" ON "_feature_flag_overrides"("flag_key", "scope_type", "scope_value");

-- CreateIndex
CREATE INDEX "_fuzz_jobs_contract_address_idx" ON "_fuzz_jobs"("contract_address");

-- CreateIndex
CREATE INDEX "_fuzz_jobs_status_idx" ON "_fuzz_jobs"("status");

-- AddForeignKey
ALTER TABLE "_wasm_upgrade_histories" ADD CONSTRAINT "_wasm_upgrade_histories_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contracts"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_transactions" ADD CONSTRAINT "_transactions_ledger_sequence_fkey" FOREIGN KEY ("ledger_sequence") REFERENCES "_ledgers"("sequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_transactions" ADD CONSTRAINT "_transactions_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contracts"("address") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_events" ADD CONSTRAINT "_events_ledger_sequence_fkey" FOREIGN KEY ("ledger_sequence") REFERENCES "_ledgers"("sequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_events" ADD CONSTRAINT "_events_transaction_hash_fkey" FOREIGN KEY ("transaction_hash") REFERENCES "_transactions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_events" ADD CONSTRAINT "_events_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contracts"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_audit_certificates" ADD CONSTRAINT "_audit_certificates_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contracts"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_audit_findings" ADD CONSTRAINT "_audit_findings_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "_audit_certificates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_audit_events" ADD CONSTRAINT "_audit_events_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "_audit_certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_verification_runs" ADD CONSTRAINT "_verification_runs_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contracts"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_propagation_analysis" ADD CONSTRAINT "_propagation_analysis_advisory_id_fkey" FOREIGN KEY ("advisory_id") REFERENCES "_vulnerability_advisories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_sponsored_transactions" ADD CONSTRAINT "_sponsored_transactions_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "_smart_wallets"("address") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_translations" ADD CONSTRAINT "_translations_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "_translation_keies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_incident_comments" ADD CONSTRAINT "_incident_comments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "_incident_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_account_trustlines" ADD CONSTRAINT "_account_trustlines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "_stellar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_account_signers" ADD CONSTRAINT "_account_signers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "_stellar_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_anchor_reviews" ADD CONSTRAINT "_anchor_reviews_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "_anchors_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_composition_pattern_instances" ADD CONSTRAINT "_composition_pattern_instances_tx_id_fkey" FOREIGN KEY ("tx_id") REFERENCES "_composed_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_composition_pattern_instances" ADD CONSTRAINT "_composition_pattern_instances_pattern_id_fkey" FOREIGN KEY ("pattern_id") REFERENCES "_composition_patterns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_composition_alerts" ADD CONSTRAINT "_composition_alerts_pattern_id_fkey" FOREIGN KEY ("pattern_id") REFERENCES "_composition_patterns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_mev_events" ADD CONSTRAINT "_mev_events_victim_address_fkey" FOREIGN KEY ("victim_address") REFERENCES "_mev_victims"("address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_mev_events" ADD CONSTRAINT "_mev_events_attacker_address_fkey" FOREIGN KEY ("attacker_address") REFERENCES "_mev_attackers"("address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_developers" ADD CONSTRAINT "_developers_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "_billing_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dev_api_keies" ADD CONSTRAINT "_dev_api_keies_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "_developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_key_rotation_audits" ADD CONSTRAINT "_key_rotation_audits_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "_developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dev_webhooks" ADD CONSTRAINT "_dev_webhooks_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "_developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_dev_webhook_deliveries" ADD CONSTRAINT "_dev_webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "_dev_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_usage_records" ADD CONSTRAINT "_usage_records_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "_developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_usage_records" ADD CONSTRAINT "_usage_records_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "_dev_api_keies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_cron_executions" ADD CONSTRAINT "_cron_executions_cron_job_id_fkey" FOREIGN KEY ("cron_job_id") REFERENCES "_cron_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_timer_alerts" ADD CONSTRAINT "_timer_alerts_scheduled_op_id_fkey" FOREIGN KEY ("scheduled_op_id") REFERENCES "_scheduled_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_price_deviations" ADD CONSTRAINT "_price_deviations_pool_id_a_fkey" FOREIGN KEY ("pool_id_a") REFERENCES "_dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_price_deviations" ADD CONSTRAINT "_price_deviations_pool_id_b_fkey" FOREIGN KEY ("pool_id_b") REFERENCES "_dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_arbitrage_opportunities" ADD CONSTRAINT "_arbitrage_opportunities_buy_pool_id_fkey" FOREIGN KEY ("buy_pool_id") REFERENCES "_dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_arbitrage_opportunities" ADD CONSTRAINT "_arbitrage_opportunities_sell_pool_id_fkey" FOREIGN KEY ("sell_pool_id") REFERENCES "_dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_mev_opportunity_scores" ADD CONSTRAINT "_mev_opportunity_scores_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "_arbitrage_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_arbitrage_executions" ADD CONSTRAINT "_arbitrage_executions_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "_arbitrage_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_pool_prices" ADD CONSTRAINT "_pool_prices_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "_dex_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_feature_values" ADD CONSTRAINT "_feature_values_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "_feature_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_attestations" ADD CONSTRAINT "_attestations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_endorsements" ADD CONSTRAINT "_endorsements_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_export_jobs" ADD CONSTRAINT "_export_jobs_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "_developers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_delegates" ADD CONSTRAINT "_governance_delegates_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_delegations" ADD CONSTRAINT "_governance_delegations_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_multisig_signers" ADD CONSTRAINT "_governance_multisig_signers_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_proposals" ADD CONSTRAINT "_governance_proposals_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_votes" ADD CONSTRAINT "_governance_votes_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_governance_votes" ADD CONSTRAINT "_governance_votes_contract_address_proposal_id_fkey" FOREIGN KEY ("contract_address", "proposal_id") REFERENCES "_governance_proposals"("contract_address", "proposal_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_treasury_accounts" ADD CONSTRAINT "_treasury_accounts_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_governance_contracts"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_treasury_assets" ADD CONSTRAINT "_treasury_assets_treasury_id_fkey" FOREIGN KEY ("treasury_id") REFERENCES "_treasury_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_treasury_payout_streams" ADD CONSTRAINT "_treasury_payout_streams_treasury_id_fkey" FOREIGN KEY ("treasury_id") REFERENCES "_treasury_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_treasury_transactions" ADD CONSTRAINT "_treasury_transactions_treasury_id_fkey" FOREIGN KEY ("treasury_id") REFERENCES "_treasury_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_linked_identities" ADD CONSTRAINT "_linked_identities_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_reputation_badges" ADD CONSTRAINT "_reputation_badges_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_reputation_dispute_votes" ADD CONSTRAINT "_reputation_dispute_votes_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "_reputation_disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_reputation_trust_connections" ADD CONSTRAINT "_reputation_trust_connections_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_reputation_signals" ADD CONSTRAINT "_reputation_signals_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_signature_inspections" ADD CONSTRAINT "_signature_inspections_transaction_hash_fkey" FOREIGN KEY ("transaction_hash") REFERENCES "_transactions"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_verifiable_credentials" ADD CONSTRAINT "_verifiable_credentials_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "_reputation_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_webhook_deliveries" ADD CONSTRAINT "_webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "_webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nl_query_contexts" ADD CONSTRAINT "nl_query_contexts_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "nl_queries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "nl_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nl_report_history" ADD CONSTRAINT "nl_report_history_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "nl_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archival_epochs" ADD CONSTRAINT "archival_epochs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "archival_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_challenges" ADD CONSTRAINT "storage_challenges_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "archival_epochs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_challenges" ADD CONSTRAINT "storage_challenges_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "archival_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_retrievals" ADD CONSTRAINT "data_retrievals_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "archival_epochs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_retrievals" ADD CONSTRAINT "data_retrievals_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "archival_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_offers" ADD CONSTRAINT "sla_offers_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "archival_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_acceptances" ADD CONSTRAINT "sla_acceptances_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "sla_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archival_slashes" ADD CONSTRAINT "archival_slashes_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "archival_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archival_slashes" ADD CONSTRAINT "archival_slashes_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "storage_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archival_appeals" ADD CONSTRAINT "archival_appeals_slashId_fkey" FOREIGN KEY ("slashId") REFERENCES "archival_slashes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_items" ADD CONSTRAINT "_nft_items_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_traits" ADD CONSTRAINT "_nft_traits_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_sales" ADD CONSTRAINT "_nft_sales_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_listings" ADD CONSTRAINT "_nft_listings_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_collection_stats" ADD CONSTRAINT "_nft_collection_stats_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_nft_activities" ADD CONSTRAINT "_nft_activities_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "_nft_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "wallet_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "wallet_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_webhooks" ADD CONSTRAINT "auth_webhooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "wallet_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ramp_orders" ADD CONSTRAINT "ramp_orders_kycId_fkey" FOREIGN KEY ("kycId") REFERENCES "ramp_kyc_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ramp_order_events" ADD CONSTRAINT "ramp_order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ramp_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_contract_source_function_details" ADD CONSTRAINT "_contract_source_function_details_contract_address_fkey" FOREIGN KEY ("contract_address") REFERENCES "_contract_sources"("contract_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_feature_flag_overrides" ADD CONSTRAINT "_feature_flag_overrides_flag_key_fkey" FOREIGN KEY ("flag_key") REFERENCES "_feature_flags"("key") ON DELETE CASCADE ON UPDATE CASCADE;

