-- Initialize Apache AGE extension and create graph schema
-- This migration sets up the hybrid relational-graph storage system

-- Enable Apache AGE extension
CREATE EXTENSION IF NOT EXISTS age;

-- Load AGE functions
LOAD 'age';

-- Set search path to include age
SET search_path = ag_catalog, "$user", public;

-- Create the main blockchain graph
SELECT create_graph('blockchain_graph');

-- Transaction Flow Graph Schema
-- Nodes: Wallet, Transaction, Contract, Event
-- Edges: SENT, CALLS, EMITS

-- Create constraints for Transaction Flow Graph
SELECT ag_catalog.create_constraint(
  'blockchain_graph',
  'wallet_address_unique',
  'Wallet',
  'address'
);

SELECT ag_catalog.create_constraint(
  'blockchain_graph',
  'tx_hash_unique',
  'Transaction',
  'hash'
);

SELECT ag_catalog.create_constraint(
  'blockchain_graph',
  'contract_address_unique',
  'Contract',
  'address'
);

SELECT ag_catalog.create_constraint(
  'blockchain_graph',
  'event_id_unique',
  'Event',
  'id'
);

-- Create indexes for Transaction Flow Graph
SELECT create_index('blockchain_graph', 'wallet_type_idx', 'Wallet', 'type');
SELECT create_index('blockchain_graph', 'tx_timestamp_idx', 'Transaction', 'timestamp');
SELECT create_index('blockchain_graph', 'contract_type_idx', 'Contract', 'type');

-- Token Transfer Graph Schema
-- Nodes: Wallet, Token
-- Edges: TRANSFERS, HELD_BY

-- Create constraint for Token nodes
SELECT ag_catalog.create_constraint(
  'blockchain_graph',
  'token_address_unique',
  'Token',
  'address'
);

-- Create indexes for Token Transfer Graph
SELECT create_index('blockchain_graph', 'token_symbol_idx', 'Token', 'symbol');
SELECT create_index('blockchain_graph', 'transfers_timestamp_idx', 'TRANSFERS', 'timestamp');

-- Contract Composability Graph Schema
-- Nodes: Contract
-- Edges: CALLS (with properties: callCount, totalGasCost, avgGasCost, reentrancyDepth, lastCallTimestamp)

-- Create indexes for Contract Composability Graph
SELECT create_index('blockchain_graph', 'contract_calls_count_idx', 'CALLS', 'callCount');
SELECT create_index('blockchain_graph', 'contract_reentrancy_idx', 'CALLS', 'reentrancyDepth');

-- Reputation Trust Graph Schema
-- Nodes: Wallet
-- Edges: TRUSTS, ATTESTS, ENDORSES

-- Create indexes for Reputation Trust Graph
SELECT create_index('blockchain_graph', 'trusts_score_idx', 'TRUSTS', 'score');
SELECT create_index('blockchain_graph', 'trusts_timestamp_idx', 'TRUSTS', 'timestamp');
SELECT create_index('blockchain_graph', 'trusts_expiration_idx', 'TRUSTS', 'expiration');

-- Create table for temporal graph metrics
CREATE TABLE IF NOT EXISTS graph_metrics_snapshot (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  node_count INT NOT NULL,
  edge_count INT NOT NULL,
  avg_degree FLOAT NOT NULL,
  max_degree INT NOT NULL,
  community_count INT NOT NULL,
  modularity_score FLOAT NOT NULL,
  new_hubs TEXT[],
  isolated_subgraphs INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create table for node embeddings (ML features)
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id VARCHAR(255) PRIMARY KEY,
  node_type VARCHAR(50) NOT NULL,
  embedding_vector FLOAT(128) NOT NULL,
  embedding_version VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create table for graph sync monitoring
CREATE TABLE IF NOT EXISTS graph_sync_log (
  id SERIAL PRIMARY KEY,
  sync_type VARCHAR(50) NOT NULL,
  source_table VARCHAR(100) NOT NULL,
  records_processed INT NOT NULL,
  sync_start_time TIMESTAMP NOT NULL,
  sync_end_time TIMESTAMP NOT NULL,
  sync_duration_ms INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for monitoring tables
CREATE INDEX IF NOT EXISTS idx_graph_metrics_snapshot_date ON graph_metrics_snapshot(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_node_embeddings_type ON node_embeddings(node_type);
CREATE INDEX IF NOT EXISTS idx_node_embeddings_version ON node_embeddings(embedding_version);
CREATE INDEX IF NOT EXISTS idx_graph_sync_log_type ON graph_sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_graph_sync_log_status ON graph_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_graph_sync_log_time ON graph_sync_log(sync_start_time);

-- Create function to update node embeddings timestamp
CREATE OR REPLACE FUNCTION update_node_embeddings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for node embeddings
CREATE TRIGGER node_embeddings_updated_at
  BEFORE UPDATE ON node_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION update_node_embeddings_timestamp();

-- Grant necessary permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, ag_catalog TO ${POSTGRES_USER:-postgres};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, ag_catalog TO ${POSTGRES_USER:-postgres};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, ag_catalog TO ${POSTGRES_USER:-postgres};
