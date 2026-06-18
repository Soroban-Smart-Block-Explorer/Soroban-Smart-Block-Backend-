-- Smart Contract Invariant Tester: Formal Verification & Runtime Monitoring Engine

-- Core Invariant Definitions
CREATE TABLE "invariant_definitions" (
    "id" UUID NOT NULL PRIMARY KEY,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(50) NOT NULL,
    "contract_address" VARCHAR(56),
    "expression" TEXT NOT NULL,
    "expression_language" VARCHAR(50) DEFAULT 'expr_lang',
    "severity" VARCHAR(20) DEFAULT 'critical',
    "check_frequency" VARCHAR(20) DEFAULT 'always',
    "gas_limit" BIGINT,
    "timeout_ms" INTEGER DEFAULT 5000,
    "is_active" BOOLEAN DEFAULT TRUE,
    "created_by" VARCHAR(56),
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_invariant_definitions_contract_address" ON "invariant_definitions"("contract_address");
CREATE INDEX "idx_invariant_definitions_category" ON "invariant_definitions"("category");
CREATE INDEX "idx_invariant_definitions_is_active" ON "invariant_definitions"("is_active");

-- Standard Invariants Template Library
CREATE TABLE "standard_invariants" (
    "id" UUID NOT NULL PRIMARY KEY,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "description" TEXT,
    "category" VARCHAR(50) NOT NULL,
    "contract_type" VARCHAR(50) NOT NULL,
    "expression_template" TEXT NOT NULL,
    "parameters" JSONB,
    "severity" VARCHAR(20) DEFAULT 'critical',
    "is_enabled_by_default" BOOLEAN DEFAULT TRUE,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_standard_invariants_contract_type" ON "standard_invariants"("contract_type");
CREATE INDEX "idx_standard_invariants_category" ON "standard_invariants"("category");

-- Expression Functions Library
CREATE TABLE "expression_functions" (
    "id" UUID NOT NULL PRIMARY KEY,
    "name" VARCHAR(100) NOT NULL UNIQUE,
    "description" TEXT,
    "category" VARCHAR(50),
    "signature" TEXT NOT NULL,
    "is_pure" BOOLEAN DEFAULT TRUE,
    "is_aggregate" BOOLEAN DEFAULT FALSE,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_expression_functions_name" ON "expression_functions"("name");
CREATE INDEX "idx_expression_functions_category" ON "expression_functions"("category");

-- Invariant Check Results
CREATE TABLE "invariant_check_results" (
    "id" BIGSERIAL NOT NULL PRIMARY KEY,
    "invariant_id" UUID NOT NULL REFERENCES "invariant_definitions"("id") ON DELETE CASCADE,
    "tx_hash" VARCHAR(64) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "result" BOOLEAN NOT NULL,
    "execution_time_ms" INTEGER,
    "gas_used" NUMERIC(20, 0),
    "state_snapshot" JSONB,
    "violation_detail" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_check_results_invariant_id" ON "invariant_check_results"("invariant_id");
CREATE INDEX "idx_check_results_tx_hash" ON "invariant_check_results"("tx_hash");
CREATE INDEX "idx_check_results_block_number" ON "invariant_check_results"("block_number");
CREATE INDEX "idx_check_results_result" ON "invariant_check_results"("result");
CREATE INDEX "idx_check_results_timestamp" ON "invariant_check_results"("timestamp" DESC);
CREATE INDEX "idx_check_results_invariant_timestamp" ON "invariant_check_results"("invariant_id", "timestamp" DESC);

-- Invariant Violations
CREATE TABLE "invariant_violations" (
    "id" BIGSERIAL NOT NULL PRIMARY KEY,
    "invariant_id" UUID NOT NULL REFERENCES "invariant_definitions"("id") ON DELETE CASCADE,
    "check_result_id" BIGINT REFERENCES "invariant_check_results"("id") ON DELETE SET NULL,
    "tx_hash" VARCHAR(64) NOT NULL,
    "block_number" BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) DEFAULT 'open',
    "assigned_to" VARCHAR(56),
    "state_before" JSONB,
    "state_after" JSONB,
    "revert_simulation" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_violations_invariant_id" ON "invariant_violations"("invariant_id");
CREATE INDEX "idx_violations_tx_hash" ON "invariant_violations"("tx_hash");
CREATE INDEX "idx_violations_status" ON "invariant_violations"("status");
CREATE INDEX "idx_violations_severity" ON "invariant_violations"("severity");
CREATE INDEX "idx_violations_timestamp" ON "invariant_violations"("timestamp" DESC);
CREATE INDEX "idx_violations_invariant_status" ON "invariant_violations"("invariant_id", "status");

-- Real-Time Monitoring Configuration
CREATE TABLE "monitoring_config" (
    "id" UUID NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL UNIQUE,
    "invariant_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "check_mode" VARCHAR(20) DEFAULT 'all',
    "sample_rate" INTEGER DEFAULT 1,
    "max_gas_per_check" NUMERIC(20, 0),
    "is_active" BOOLEAN DEFAULT TRUE,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_monitoring_config_contract_address" ON "monitoring_config"("contract_address");
CREATE INDEX "idx_monitoring_config_is_active" ON "monitoring_config"("is_active");

-- Monitoring Statistics
CREATE TABLE "monitoring_stats" (
    "id" BIGSERIAL NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL UNIQUE,
    "total_checks" BIGINT DEFAULT 0,
    "passed_checks" BIGINT DEFAULT 0,
    "failed_checks" BIGINT DEFAULT 0,
    "avg_check_time_ms" NUMERIC(10, 2),
    "total_gas_used" NUMERIC(30, 0),
    "last_check_at" TIMESTAMPTZ,
    "last_violation_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_monitoring_stats_contract_address" ON "monitoring_stats"("contract_address");
CREATE INDEX "idx_monitoring_stats_last_violation_at" ON "monitoring_stats"("last_violation_at");

-- Invariant Mining Runs
CREATE TABLE "invariant_mining_runs" (
    "id" UUID NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL,
    "mining_type" VARCHAR(50) NOT NULL,
    "tx_range_start" BIGINT,
    "tx_range_end" BIGINT,
    "discovered_invariants" JSONB,
    "total_candidates" INTEGER,
    "confirmed_count" INTEGER,
    "false_positive_count" INTEGER,
    "runtime_seconds" INTEGER,
    "status" VARCHAR(20) DEFAULT 'running',
    "started_at" TIMESTAMPTZ DEFAULT NOW(),
    "completed_at" TIMESTAMPTZ
);

CREATE INDEX "idx_mining_runs_contract_address" ON "invariant_mining_runs"("contract_address");
CREATE INDEX "idx_mining_runs_status" ON "invariant_mining_runs"("status");
CREATE INDEX "idx_mining_runs_started_at" ON "invariant_mining_runs"("started_at" DESC);

-- Invariant Candidates
CREATE TABLE "invariant_candidates" (
    "id" BIGSERIAL NOT NULL PRIMARY KEY,
    "mining_run_id" UUID NOT NULL REFERENCES "invariant_mining_runs"("id") ON DELETE CASCADE,
    "expression" TEXT NOT NULL,
    "confidence" NUMERIC(5, 4),
    "support_count" INTEGER,
    "counterexample_count" INTEGER,
    "is_confirmed" BOOLEAN DEFAULT FALSE,
    "confirmed_at" TIMESTAMPTZ
);

CREATE INDEX "idx_candidates_mining_run_id" ON "invariant_candidates"("mining_run_id");
CREATE INDEX "idx_candidates_is_confirmed" ON "invariant_candidates"("is_confirmed");

-- Fuzz Campaigns
CREATE TABLE "fuzz_campaigns" (
    "id" UUID NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL,
    "name" VARCHAR(255),
    "invariant_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "total_iterations" INTEGER,
    "iterations_executed" INTEGER DEFAULT 0,
    "coverage_percentage" NUMERIC(5, 2),
    "violations_found" INTEGER DEFAULT 0,
    "status" VARCHAR(20) DEFAULT 'pending',
    "config" JSONB,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_fuzz_campaigns_contract_address" ON "fuzz_campaigns"("contract_address");
CREATE INDEX "idx_fuzz_campaigns_status" ON "fuzz_campaigns"("status");
CREATE INDEX "idx_fuzz_campaigns_created_at" ON "fuzz_campaigns"("created_at" DESC);

-- Fuzz Transactions
CREATE TABLE "fuzz_transactions" (
    "id" BIGSERIAL NOT NULL PRIMARY KEY,
    "campaign_id" UUID NOT NULL REFERENCES "fuzz_campaigns"("id") ON DELETE CASCADE,
    "iteration" INTEGER NOT NULL,
    "calldata" TEXT NOT NULL,
    "gas_used" NUMERIC(20, 0),
    "reverted" BOOLEAN DEFAULT FALSE,
    "coverage_metrics" JSONB,
    "invariant_results" JSONB,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_fuzz_transactions_campaign_id" ON "fuzz_transactions"("campaign_id");
CREATE INDEX "idx_fuzz_transactions_iteration" ON "fuzz_transactions"("campaign_id", "iteration");

-- Invariant Alert Rules
CREATE TABLE "invariant_alert_rules" (
    "id" UUID NOT NULL PRIMARY KEY,
    "invariant_id" UUID NOT NULL REFERENCES "invariant_definitions"("id") ON DELETE CASCADE,
    "min_severity" VARCHAR(20) DEFAULT 'warning',
    "cooldown_seconds" INTEGER DEFAULT 300,
    "escalate_after_count" INTEGER DEFAULT 3,
    "escalate_window_minutes" INTEGER DEFAULT 60,
    "notification_channels" JSONB,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_alert_rules_invariant_id" ON "invariant_alert_rules"("invariant_id");

-- Symbolic Execution Results
CREATE TABLE "symbolic_execution_results" (
    "id" UUID NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL,
    "function_name" VARCHAR(255),
    "paths_explored" INTEGER,
    "assertion_violations" JSONB,
    "reentrancy_risks" JSONB,
    "arithmetic_issues" JSONB,
    "generated_test_cases" JSONB,
    "status" VARCHAR(20) DEFAULT 'pending',
    "started_at" TIMESTAMPTZ DEFAULT NOW(),
    "completed_at" TIMESTAMPTZ
);

CREATE INDEX "idx_symbolic_exec_contract_address" ON "symbolic_execution_results"("contract_address");
CREATE INDEX "idx_symbolic_exec_status" ON "symbolic_execution_results"("status");

-- Compliance Frameworks
CREATE TABLE "compliance_frameworks" (
    "id" UUID NOT NULL PRIMARY KEY,
    "name" VARCHAR(255) NOT NULL UNIQUE,
    "description" TEXT,
    "version" VARCHAR(20),
    "rules" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_compliance_frameworks_name" ON "compliance_frameworks"("name");

-- Compliance Audits
CREATE TABLE "compliance_audits" (
    "id" UUID NOT NULL PRIMARY KEY,
    "contract_address" VARCHAR(56) NOT NULL,
    "framework_id" UUID REFERENCES "compliance_frameworks"("id") ON DELETE SET NULL,
    "status" VARCHAR(20) DEFAULT 'pending',
    "passed_rules" INTEGER DEFAULT 0,
    "failed_rules" INTEGER DEFAULT 0,
    "total_rules" INTEGER NOT NULL,
    "report" JSONB,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_compliance_audits_contract_address" ON "compliance_audits"("contract_address");
CREATE INDEX "idx_compliance_audits_framework_id" ON "compliance_audits"("framework_id");
CREATE INDEX "idx_compliance_audits_status" ON "compliance_audits"("status");

-- Historical Re-Verification Jobs
CREATE TABLE "reverify_jobs" (
    "id" UUID NOT NULL PRIMARY KEY,
    "invariant_id" UUID NOT NULL REFERENCES "invariant_definitions"("id") ON DELETE CASCADE,
    "block_range_start" BIGINT,
    "block_range_end" BIGINT,
    "total_blocks" BIGINT,
    "processed_blocks" BIGINT DEFAULT 0,
    "violations_found" INTEGER DEFAULT 0,
    "status" VARCHAR(20) DEFAULT 'running',
    "started_at" TIMESTAMPTZ DEFAULT NOW(),
    "completed_at" TIMESTAMPTZ
);

CREATE INDEX "idx_reverify_jobs_invariant_id" ON "reverify_jobs"("invariant_id");
CREATE INDEX "idx_reverify_jobs_status" ON "reverify_jobs"("status");
CREATE INDEX "idx_reverify_jobs_started_at" ON "reverify_jobs"("started_at" DESC);

-- Invariant Repair Suggestions
CREATE TABLE "invariant_repairs" (
    "id" UUID NOT NULL PRIMARY KEY,
    "violation_id" BIGINT NOT NULL REFERENCES "invariant_violations"("id") ON DELETE CASCADE,
    "contract_address" VARCHAR(56) NOT NULL,
    "original_expression" TEXT NOT NULL,
    "suggested_patch" TEXT NOT NULL,
    "patch_type" VARCHAR(50),
    "confidence_score" NUMERIC(5, 4),
    "verification_status" VARCHAR(20),
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_repairs_violation_id" ON "invariant_repairs"("violation_id");
CREATE INDEX "idx_repairs_contract_address" ON "invariant_repairs"("contract_address");

-- Cross-Contract Composability Analysis
CREATE TABLE "cross_contract_analysis" (
    "id" UUID NOT NULL PRIMARY KEY,
    "source_contract" VARCHAR(56) NOT NULL,
    "target_contract" VARCHAR(56) NOT NULL,
    "interaction_type" VARCHAR(50),
    "composability_issues" JSONB,
    "state_inconsistencies" JSONB,
    "reentrancy_risks" JSONB,
    "confidence_score" NUMERIC(5, 4),
    "analyzed_at" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX "idx_cross_contract_source" ON "cross_contract_analysis"("source_contract");
CREATE INDEX "idx_cross_contract_target" ON "cross_contract_analysis"("target_contract");
CREATE INDEX "idx_cross_contract_source_target" ON "cross_contract_analysis"("source_contract", "target_contract");

-- Foreign key constraint for monitoring_config to monitoring_stats
ALTER TABLE "monitoring_stats"
    ADD CONSTRAINT "fk_monitoring_stats_config" 
    FOREIGN KEY ("contract_address") REFERENCES "monitoring_config"("contract_address") ON DELETE CASCADE;
