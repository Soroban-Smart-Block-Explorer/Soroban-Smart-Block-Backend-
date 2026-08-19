-- Migration: Create adaptive indexer tables
-- Date: 2026-07-16
-- Description: Tables for adaptive polling, predictive model, degradation tracking

-- Table 1: Adaptive Polling State
CREATE TABLE IF NOT EXISTS adaptive_polling_state (
  id SERIAL PRIMARY KEY,
  polling_interval_ms INT NOT NULL,
  batch_size INT NOT NULL,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  ema_interval_ms INT NOT NULL,
  CONSTRAINT valid_intervals CHECK (polling_interval_ms >= 100 AND polling_interval_ms <= 5000)
);

CREATE INDEX IF NOT EXISTS idx_adaptive_polling_state_last_updated 
  ON adaptive_polling_state(last_updated DESC);

-- Table 2: Prediction Models
CREATE TABLE IF NOT EXISTS prediction_models (
  id SERIAL PRIMARY KEY,
  model_type VARCHAR(50) NOT NULL,
  version INT NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL,
  rmse DECIMAL(5, 4) NOT NULL,
  features JSONB NOT NULL,
  weights_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_model_version UNIQUE (model_type, version)
);

CREATE INDEX IF NOT EXISTS idx_prediction_models_active 
  ON prediction_models(is_active) WHERE is_active = TRUE;

-- Table 3: Predictions (for accuracy tracking)
CREATE TABLE IF NOT EXISTS predictions (
  id BIGSERIAL PRIMARY KEY,
  model_id INT REFERENCES prediction_models(id),
  timestamp TIMESTAMPTZ NOT NULL,
  horizon_minutes INT NOT NULL,
  predicted_throughput DECIMAL(10, 2) NOT NULL,
  actual_throughput DECIMAL(10, 2),
  confidence DECIMAL(5, 4) NOT NULL,
  error_rate DECIMAL(5, 4),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_horizon CHECK (horizon_minutes > 0)
);

CREATE INDEX IF NOT EXISTS idx_predictions_created_at 
  ON predictions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_model_id 
  ON predictions(model_id);
CREATE INDEX IF NOT EXISTS idx_predictions_timestamp 
  ON predictions(timestamp DESC);

-- Table 4: Degradation Events
CREATE TABLE IF NOT EXISTS degradation_events (
  id BIGSERIAL PRIMARY KEY,
  load_level VARCHAR(20) NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  reason VARCHAR(255),
  skipped_events_count INT,
  backfill_queue_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_load_level CHECK (load_level IN ('NORMAL', 'MODERATE', 'HIGH', 'CRITICAL'))
);

CREATE INDEX IF NOT EXISTS idx_degradation_events_created_at 
  ON degradation_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_degradation_events_load_level 
  ON degradation_events(load_level);

-- Table 5: Skipped Ledgers (for backfill)
CREATE TABLE IF NOT EXISTS skipped_ledgers (
  id BIGSERIAL PRIMARY KEY,
  ledger_id BIGINT NOT NULL UNIQUE,
  reason VARCHAR(50) NOT NULL,
  priority_level VARCHAR(5) NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL,
  backfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_priority CHECK (priority_level IN ('P0', 'P1', 'P2', 'P3')),
  CONSTRAINT valid_reason CHECK (reason IN ('load_shedding', 'sampling', 'manual_skip'))
);

CREATE INDEX IF NOT EXISTS idx_skipped_ledgers_ledger_id 
  ON skipped_ledgers(ledger_id);
CREATE INDEX IF NOT EXISTS idx_skipped_ledgers_backfilled_at 
  ON skipped_ledgers(backfilled_at) WHERE backfilled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skipped_ledgers_priority 
  ON skipped_ledgers(priority_level);

-- Table 6: Control Plane Overrides
CREATE TABLE IF NOT EXISTS control_plane_overrides (
  id SERIAL PRIMARY KEY,
  setting_name VARCHAR(100) NOT NULL UNIQUE,
  setting_value JSONB NOT NULL,
  reason TEXT,
  operator_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT unique_active_setting UNIQUE (setting_name) 
    WHERE expires_at IS NULL OR expires_at > NOW()
);

CREATE INDEX IF NOT EXISTS idx_control_plane_overrides_expires_at 
  ON control_plane_overrides(expires_at);

-- Hypertable conversion for better time-series performance (if using TimescaleDB)
-- SELECT create_hypertable('predictions', 'created_at', if_not_exists => TRUE);
-- SELECT create_hypertable('degradation_events', 'created_at', if_not_exists => TRUE);

-- Insert default row for polling state
INSERT INTO adaptive_polling_state (polling_interval_ms, batch_size, ema_interval_ms)
VALUES (5000, 1, 5000)
ON CONFLICT DO NOTHING;

-- Insert default model placeholder
INSERT INTO prediction_models (model_type, version, trained_at, rmse, features, weights_url, is_active)
VALUES (
  'lstm-v2',
  1,
  NOW(),
  0.15,
  '{"sequence_length": 168, "horizons": [5, 15, 30, 60], "features": 8}'::jsonb,
  'indexeddb://soroban-activity-predictor',
  FALSE
)
ON CONFLICT DO NOTHING;
