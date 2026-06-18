-- Emergency Response Platform migration

CREATE TABLE "emergency_states" (
  "id" TEXT NOT NULL,
  "contract_address" VARCHAR(56) NOT NULL,
  "is_paused" BOOLEAN NOT NULL DEFAULT false,
  "current_pause_id" TEXT,
  "total_pause_count" INTEGER NOT NULL DEFAULT 0,
  "total_paused_seconds" BIGINT NOT NULL DEFAULT 0,
  "last_pause_duration_seconds" BIGINT,
  "pauser_type" VARCHAR(30),
  "decentralization_score" DECIMAL(5,2),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "emergency_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "emergency_states_contract_address_key" ON "emergency_states"("contract_address");
CREATE INDEX "emergency_states_contract_address_idx" ON "emergency_states"("contract_address");

CREATE TABLE "pause_events" (
  "id" TEXT NOT NULL,
  "contract_address" VARCHAR(56) NOT NULL,
  "event_type" VARCHAR(20) NOT NULL,
  "pauser_address" VARCHAR(56),
  "reason" TEXT,
  "tx_hash" VARCHAR(64) NOT NULL,
  "block_number" BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  "duration_seconds" BIGINT,
  "gas_cost" BIGINT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "pause_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pause_events_contract_address_idx" ON "pause_events"("contract_address");
CREATE INDEX "pause_events_event_type_idx" ON "pause_events"("event_type");
CREATE INDEX "pause_events_timestamp_idx" ON "pause_events"("timestamp");
CREATE INDEX "pause_events_pauser_address_idx" ON "pause_events"("pauser_address");

CREATE TABLE "pauser_analyses" (
  "id" TEXT NOT NULL,
  "contract_address" VARCHAR(56) NOT NULL,
  "pauser_type" VARCHAR(30) NOT NULL,
  "pauser_addresses" TEXT[] NOT NULL,
  "unpauser_addresses" TEXT[],
  "threshold" INTEGER,
  "total_signers" INTEGER,
  "timelock_delay_seconds" BIGINT,
  "governance_contract" VARCHAR(56),
  "automatic_triggers" JSONB,
  "analysis_method" VARCHAR(30),
  "last_analyzed" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "pauser_analyses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pauser_analyses_contract_address_key" ON "pauser_analyses"("contract_address");

CREATE TABLE "recovery_analyses" (
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
  "last_analyzed" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "recovery_analyses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "recovery_analyses_contract_address_key" ON "recovery_analyses"("contract_address");

CREATE TABLE "alert_configurations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "contract_address" VARCHAR(56),
  "name" VARCHAR(255),
  "alert_type" VARCHAR(50) NOT NULL,
  "conditions" JSONB,
  "channels" JSONB NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
  "last_triggered_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "alert_configurations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alert_configurations_user_id_idx" ON "alert_configurations"("user_id");
CREATE INDEX "alert_configurations_contract_address_idx" ON "alert_configurations"("contract_address");

CREATE TABLE "incident_reports" (
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
  "resolved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "incident_reports_contract_address_idx" ON "incident_reports"("contract_address");
CREATE INDEX "incident_reports_status_idx" ON "incident_reports"("status");
CREATE INDEX "incident_reports_severity_idx" ON "incident_reports"("severity");
CREATE INDEX "incident_reports_created_at_idx" ON "incident_reports"("created_at");

CREATE TABLE "incident_comments" (
  "id" TEXT NOT NULL,
  "incident_id" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "incident_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "incident_comments_incident_id_idx" ON "incident_comments"("incident_id");

CREATE TABLE "protocol_health_scores" (
  "id" TEXT NOT NULL,
  "contract_address" VARCHAR(56) NOT NULL,
  "protocol_name" VARCHAR(255),
  "total_pauses_30d" INTEGER NOT NULL DEFAULT 0,
  "total_pauses_90d" INTEGER NOT NULL DEFAULT 0,
  "avg_pause_duration_30d" BIGINT,
  "total_downtime_30d" BIGINT,
  "last_pause_date" TIMESTAMPTZ,
  "recovery_score" DECIMAL(5,2),
  "decentralization_score" DECIMAL(5,2),
  "health_score" DECIMAL(5,2),
  "risk_level" VARCHAR(20),
  "computed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "protocol_health_scores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "protocol_health_scores_contract_address_key" ON "protocol_health_scores"("contract_address");
CREATE INDEX "protocol_health_scores_health_score_idx" ON "protocol_health_scores"("health_score");
