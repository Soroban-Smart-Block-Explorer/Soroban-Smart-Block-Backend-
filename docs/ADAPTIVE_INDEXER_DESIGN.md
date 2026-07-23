# Adaptive Indexer Design: Scaling for High-Throughput Soroban Networks

**Status**: Design Document for Implementation  
**Date**: July 2026  
**Target Performance**: <5s behind real-time at 99th percentile activity, auto-scaling before 90% of spikes

## Table of Contents
1. [Problem Statement](#problem-statement)
2. [Architecture Overview](#architecture-overview)
3. [Adaptive Polling & Processing](#adaptive-polling--processing)
4. [Predictive Auto-Scaling](#predictive-auto-scaling)
5. [Distributed Processing Pipeline](#distributed-processing-pipeline)
6. [Graceful Degradation](#graceful-degradation)
7. [Monitoring & Control Plane](#monitoring--control-plane)
8. [Backpressure & Flow Control](#backpressure--flow-control)
9. [Data Models & State Management](#data-models--state-management)
10. [Deployment & Operations](#deployment--operations)

---

## Problem Statement

**Current State Issues**:
- Fixed 5-second polling interval wastes resources during idle periods and causes lag during high activity (500+ tx/s)
- No adaptive response to network conditions
- No predictive scaling—always reactive after lag appears
- No graceful degradation—pods get OOM-killed under load spikes
- Missing observability for operational control

**Target State**: 
- Indexer maintains <5s lag during 99th percentile activity
- Auto-scales *before* activity spikes (predictive, not reactive)
- Gracefully handles 10x load spikes without node failures
- Operator control plane for manual override and cost optimization

---

## Architecture Overview

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                      Network / Blockchain                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   ┌────▼────┐     ┌──────▼──────┐    ┌──────▼──────┐
   │ Ingester│     │ Predictor   │    │ Monitoring  │
   │ Workers │     │ & Scaler    │    │ Dashboard   │
   └────┬────┘     └──────┬──────┘    └──────┬──────┘
        │                 │                   │
        │          ┌──────▼──────┐            │
        │          │ NATS Queue  │            │
        │          │ raw-ledgers │            │
        │          └──────┬──────┘            │
        │                 │                   │
        │    ┌────────────┼────────────┐      │
        │    │            │            │      │
   ┌────▼────▼──┐  ┌──────▼──────┐  ┌─▼────────┐
   │  Decoder   │  │  Enrichment │  │ Graceful │
   │  Workers   │  │  Workers    │  │ Degrader │
   │            │  │             │  │ (L1-L3)  │
   └────┬───────┘  └──────┬──────┘  └─┬───────┘
        │          NATS   │          │
        │     decoded-txs │          │
        │          NATS   │          │
        │    enriched-events         │
        │                 │          │
        └────────┬────────┴──────────┘
                 │
        ┌────────▼────────┐
        │   Database      │
        │   (TimescaleDB) │
        └─────────────────┘
```

### Key Components

1. **Adaptive Polling Layer**: Monitors ledger close rate vs. processing rate
2. **Predictive Scaler**: ML-based model predicting activity spikes
3. **NATS Message Queue**: Decouples ingestion from processing
4. **Graceful Degrader**: Drops non-essential work under high load
5. **Control Plane**: Dashboard + operator overrides
6. **Backpressure System**: Propagates queue depth signals upstream

---

## Adaptive Polling & Processing

### 1.1 Dynamic Polling Interval

**Algorithm: Adaptive Polling with Exponential Backoff**

```
Input: 
  - ledgers_behind: number of unprocessed ledgers
  - processing_queue_depth: messages in NATS queue
  - available_workers: number of idle workers
  - current_poll_interval: milliseconds

Output:
  - new_poll_interval: next poll interval (ms)

Logic:
1. If ledgers_behind > 100:
     new_interval = current_interval * 0.5  (halve)
   Else if ledgers_behind == 0 AND processing_queue_depth == 0:
     new_interval = min(current_interval * 1.2, MAX_INTERVAL)  (increase up to 5s)
   Else if ledgers_behind > 0 AND available_workers > 0:
     new_interval = current_interval * 0.9  (slight reduction)
   Else:
     new_interval = current_interval

2. Clamp: new_interval = clamp(new_interval, MIN_INTERVAL=100ms, MAX_INTERVAL=5000ms)

3. Return new_interval
```

**Implementation**:
- Tracked in `IndexerState.adaptivePollingConfig`
- Updated every 10 ledger closes
- Smooth transitions using exponential smoothing: `interval_ema = 0.8 * prev_ema + 0.2 * new_interval`

### 1.2 Batch Processing

**Strategy**: 
- **Real-time mode** (ledgers_behind < 10): process 1 ledger at a time with <1s latency
- **Batch mode** (ledgers_behind >= 10): process 5-10 ledgers in a batch
- **Catch-up mode** (ledgers_behind > 100): process 20-50 ledgers in a batch, skip empty ledgers

**Empty Ledger Detection**:
```typescript
async function isEmptyLedger(ledgerId: number): Promise<boolean> {
  // Fetch only ledger header (cheap operation)
  const header = await sorobanRpc.getLedger(ledgerId);
  
  // If tx_set_hash == previous_tx_set_hash, no new transactions
  if (header.tx_set_hash === previousHash) {
    return true;
  }
  
  // If no relevant contract events, skip
  const eventCount = await sorobanRpc.getEventCount(ledgerId, relevantContracts);
  return eventCount === 0;
}
```

### 1.3 Priority Queuing

**Priority Levels**:
1. **P0** (Critical): Watchlisted contracts (high TVL, high value)
2. **P1** (High): Recently active contracts
3. **P2** (Normal): All other contracts
4. **P3** (Low): Archive/historical contracts

**Implementation**:
- `ProcessingQueue` with priority field
- NATS JetStream ordered consumers with priority filters
- Dynamically update priorities based on TVL rankings (hourly)

---

## Predictive Auto-Scaling

### 2.1 Activity Prediction Model

**Features** (inputs to ML model):

| Feature | Source | Update Freq | Notes |
|---------|--------|-------------|-------|
| hour_of_day | system | real-time | 0-23 |
| day_of_week | system | real-time | 0-6 (Mon-Sun) |
| recent_throughput | metrics | 10s | txs in last 10 min |
| queue_depth_trend | NATS | 10s | slope of queue depth |
| contract_deployment_count | indexer | 1min | new contracts deployed |
| protocol_upgrade_flag | config | on-change | manual flag |
| external_signals | API | 5min | Twitter mentions, exchange listings |
| holidays_flag | config | daily | major crypto events |

**Model Architecture**:
```
LSTM-based time series predictor:
  Input: 168 samples × 8 features (7 days of history)
  Hidden: 2 LSTM layers (128 units each) + Dropout(0.2)
  Output: 4 predictions (5min, 15min, 30min, 1hr ahead)
  
Loss: MAE (Mean Absolute Error)
Target: RMSE < 15% on ledger activity volume
```

**Training Data**:
- Historical ledger counts per 5-minute window
- 6+ months of mainnet data
- Retrain weekly; deploy hot-swapped model

**Prediction Example**:
```
Current time: 14:00 UTC (2:00 PM)
Recent throughput: 50 tx/s (normal)
Hour_of_day: 14
Day_of_week: 2 (Wed)
External signal: Major exchange listing announced 2 hours ago

Model prediction (confidence interval):
  5 min ahead:  150 tx/s (±20)
  15 min ahead: 250 tx/s (±40)
  30 min ahead: 280 tx/s (±50)
  1 hr ahead:   200 tx/s (±60)

Action: Scale up NOW (before spike occurs)
```

### 2.2 Auto-Scaling Logic

**Kubernetes HPA with Custom Metrics**:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: indexer-workers-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: indexer-workers
  minReplicas: 4
  maxReplicas: 64
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: nats_queue_depth  # Custom metric
      target:
        type: AverageValue
        averageValue: "50"  # Average depth per consumer
  - type: Pods
    pods:
      metric:
        name: indexer_predicted_throughput  # Custom metric from ML model
      target:
        type: AverageValue
        averageValue: "200"  # Predicted tx/s per worker
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Percent
        value: 100  # Double workers if needed
        periodSeconds: 15
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10   # Slow drain
        periodSeconds: 60
```

**Predictive Scale-Up Decision**:
```typescript
// In predictive scaler service
const prediction = await predictor.predictThroughput({
  horizon: 5, // minutes ahead
  confidence: 0.9
});

if (prediction.txPerSecond > THROUGHPUT_THRESHOLD) {
  const requiredWorkers = Math.ceil(prediction.txPerSecond / TX_PER_WORKER);
  const currentWorkers = await k8s.getReplicaCount();
  
  if (requiredWorkers > currentWorkers) {
    // Pre-scale 2 minutes before predicted spike
    await k8s.scale(requiredWorkers);
    await metrics.record('predictive_scale_triggered', requiredWorkers);
  }
}
```

### 2.3 Worker Pool Specialization

**Worker Types**:

1. **Ingester Workers** (ingestion stage)
   - Fetch raw ledger XDR
   - Detect reorgs
   - Publish to `raw-ledgers` NATS topic
   - Scale: based on ledger close rate
   - CPU-bound, low memory

2. **Decoder Workers** (decoding stage)
   - Parse XDR
   - Extract transaction details
   - Publish to `decoded-transactions` topic
   - Scale: based on `raw-ledgers` queue depth
   - CPU-bound, high memory

3. **Enrichment Workers** (enrichment stage)
   - Analyze composability
   - Classify MEV
   - Detect arbitrage
   - Publish to `enriched-events` topic
   - Scale: based on `decoded-transactions` queue depth
   - I/O-bound (external APIs)

4. **Analytics Workers** (optional)
   - Aggregations
   - User-facing dashboards
   - Scale: based on `enriched-events` queue depth
   - Low priority, gracefully degrade under load

---

## Distributed Processing Pipeline

### 3.1 NATS JetStream Configuration

**Rationale**: 
- Decouples processing stages
- Built-in queue management and backpressure
- Multi-consumer support with load balancing
- Message replay for recovery

**Topics & Consumers**:

```typescript
// Topic 1: Raw Ledgers
namespace: 'soroban'
topic: 'raw-ledgers'
retention: WorkPolicy (keep until processed)
maxMsgSize: 10MB
consumers:
  - decoder-workers (pull, max_ack_pending=100)
  - archive-backup (push to S3)

// Topic 2: Decoded Transactions
namespace: 'soroban'
topic: 'decoded-transactions'
retention: WorkPolicy
maxMsgSize: 5MB
consumers:
  - enrichment-workers (pull, max_ack_pending=50)
  - analytics-workers (push, optional)

// Topic 3: Enriched Events
namespace: 'soroban'
topic: 'enriched-events'
retention: 24h (for client queries)
maxMsgSize: 1MB
consumers:
  - database-sink (push, rate_limit=1000/s)
  - websocket-broadcaster (push)
```

**Message Schema**:

```typescript
// raw-ledgers
interface RawLedgerMessage {
  ledgerId: number;
  closeTime: number;
  xdr: string;
  hash: string;
  timestamp: number; // ingestion time
}

// decoded-transactions
interface DecodedTransactionMessage {
  ledgerId: number;
  txId: string;
  source: string;
  operations: Operation[];
  sorobanEvents: SorobanEvent[];
  timestamp: number; // decoding time
}

// enriched-events
interface EnrichedEventMessage {
  ledgerId: number;
  eventId: string;
  contract: string;
  eventType: 'transfer' | 'swap' | 'liquidation' | etc;
  mevScore?: number;
  composabilityAnalysis?: ComposabilityData;
  relatedContracts: string[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  timestamp: number; // enrichment time
}
```

### 3.2 Backpressure Propagation

**Algorithm**: Propagate queue depth upstream to slow down ingestion

```typescript
// Monitor all downstream queues
async function monitorBackpressure() {
  const queueDepths = {
    rawLedgers: await nats.getQueueDepth('raw-ledgers'),
    decodedTxs: await nats.getQueueDepth('decoded-transactions'),
    enrichedEvents: await nats.getQueueDepth('enriched-events')
  };
  
  // Calculate backpressure signal (0.0 to 1.0)
  const maxDepth = 10000;
  const backpressure = Math.max(
    queueDepths.rawLedgers / maxDepth,
    queueDepths.decodedTxs / maxDepth,
    queueDepths.enrichedEvents / maxDepth
  );
  
  if (backpressure > 0.8) {
    // Slow down ingestion
    await setPollingInterval(Math.max(currentInterval * 1.5, MAX_INTERVAL));
    await metrics.record('backpressure_triggered', backpressure);
  }
}
```

---

## Graceful Degradation

### 4.1 Load Levels

**Level 1 - Moderate Load** (ledgers_behind 10-50)
- **Trigger**: Queue depth > 5000 messages
- **Actions**:
  - Skip composability analysis (complex cross-contract calls)
  - Skip MEV classification (only detect obvious arbitrage)
  - Reduce enrichment detail (keep basic event data)
- **Impact**: ~30% reduction in enrichment latency, minimal data loss

**Level 2 - High Load** (ledgers_behind 50-200)
- **Trigger**: Queue depth > 15000 messages
- **Actions**:
  - Sample events: process only high-priority contracts (P0, P1)
  - Skip non-critical contracts (P3)
  - Disable analytics workers
  - Reduce database write batch sizes
- **Impact**: ~60% reduction in processing load, selective data loss (non-critical contracts)

**Level 3 - Critical Load** (ledgers_behind > 200)
- **Trigger**: Queue depth > 30000 messages OR OOM risk detected
- **Actions**:
  - Process ONLY watchlisted contracts (user-selected)
  - Store raw ledger headers only (no event parsing)
  - Queue everything else for backfill when load normalizes
  - Emergency alerting to on-call team
- **Impact**: ~90% load reduction, intentional data loss (recoverable)

### 4.2 Graceful Degradation Implementation

```typescript
enum LoadLevel {
  NORMAL = 'normal',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical'
}

interface DegradationConfig {
  level: LoadLevel;
  enableComposability: boolean;
  enableMevClassification: boolean;
  enableAnalytics: boolean;
  sampleRate: number; // 1.0 = all, 0.1 = 10%
  priorityFilter: 'all' | 'p0_p1' | 'p0_only'; // which contracts to process
  batchSize: number; // database writes
}

async function evaluateLoadLevel(): Promise<LoadLevel> {
  const metrics = {
    queueDepth: await nats.getQueueDepth(),
    ledgersBehind: await indexer.getLedgersBehind(),
    memoryUsage: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
    cpuUsage: await os.getLoadAverage()[0] / os.cpus().length
  };
  
  if (memoryUsage > 0.95 || queueDepth > 30000) {
    return LoadLevel.CRITICAL;
  } else if (queueDepth > 15000 || ledgersBehind > 50) {
    return LoadLevel.HIGH;
  } else if (queueDepth > 5000 || ledgersBehind > 10) {
    return LoadLevel.MODERATE;
  }
  
  return LoadLevel.NORMAL;
}

async function applyDegradation(level: LoadLevel) {
  const config = getDegradationConfig(level);
  
  switch (level) {
    case LoadLevel.MODERATE:
      config.enableComposability = false;
      config.enableMevClassification = false;
      config.sampleRate = 1.0;
      break;
    case LoadLevel.HIGH:
      config.enableAnalytics = false;
      config.priorityFilter = 'p0_p1';
      config.sampleRate = 0.8;
      config.batchSize = 50;
      break;
    case LoadLevel.CRITICAL:
      config.enableAnalytics = false;
      config.priorityFilter = 'p0_only';
      config.sampleRate = 0.2;
      config.batchSize = 100;
      await alertOnCall('CRITICAL load level triggered');
      break;
  }
  
  await setGlobalDegradationConfig(config);
  await metrics.record('degradation_level', level);
}
```

### 4.3 Auto-Recovery & Backfill

```typescript
async function backfillSkippedData() {
  // Run when load normalizes (backpressure < 0.2 for 5 minutes)
  
  const skippedLedgers = await db.query(`
    SELECT DISTINCT ledger_id 
    FROM skipped_ledgers 
    WHERE reason = 'load_shedding'
    AND priority_level IN ('P1', 'P2', 'P3')
    ORDER BY priority_level DESC, ledger_id ASC
    LIMIT 1000
  `);
  
  for (const ledger of skippedLedgers) {
    // Re-process with full enrichment
    await reprocessLedger(ledger.ledger_id);
    
    // Batch every 100 ledgers
    if (skippedLedgers.indexOf(ledger) % 100 === 0) {
      await sleep(100); // brief pause
    }
  }
  
  await db.delete('skipped_ledgers', { reason: 'load_shedding' });
}
```

---

## Monitoring & Control Plane

### 5.1 Key Metrics

**Ingestion Metrics**:
- `soroban_indexer_ledgers_behind` (gauge): number of unprocessed ledgers
- `soroban_indexer_polling_interval_ms` (gauge): current adaptive interval
- `soroban_indexer_ledger_close_rate` (gauge): tx/s from blockchain
- `soroban_indexer_ingestion_rate` (gauge): processed ledgers/s

**Queue Metrics**:
- `nats_queue_depth` (gauge, per topic): messages awaiting processing
- `nats_throughput` (counter, per topic): messages processed/s
- `nats_ack_latency_ms` (histogram): message acknowledgment latency

**Worker Metrics**:
- `indexer_worker_count` (gauge): current replica count (per worker type)
- `indexer_worker_utilization` (gauge): CPU/memory per worker
- `indexer_worker_scaling_events` (counter): scale up/down events

**Degradation Metrics**:
- `soroban_degradation_level` (gauge): current load level (0-3)
- `soroban_skipped_events_total` (counter): events sampled/skipped
- `soroban_backfill_queue_depth` (gauge): events awaiting backfill

**Prediction Metrics**:
- `predictor_rmse` (gauge): model error on recent predictions
- `predictor_predictions_made` (counter): number of scaling decisions
- `predictor_accuracy_rate` (gauge): % of predictions within 20% error

### 5.2 Dashboard Components

**Real-time Dashboard** (Grafana):
```
┌─────────────────────────────────────────────────┐
│ ADAPTIVE INDEXER CONTROL PLANE                  │
├─────────────────────────────────────────────────┤
│ Ledgers Behind: 5 | Processing Rate: 1200 tx/s  │
│ Load Level: NORMAL | Backpressure: 0.15         │
├─────────────────────────────────────────────────┤
│ Polling Interval: 450ms ▼ (adaptive)             │
│ Worker Count: 8 (normal) / 4 (P0) / 2 (analytics)│
│ Queue Depth: raw=200, decoded=150, enriched=100 │
├─────────────────────────────────────────────────┤
│ Prediction (5min): 450 tx/s (confidence: 92%)   │
│ Predicted Scale Action: ↑ +2 workers @ 14:35    │
├─────────────────────────────────────────────────┤
│ [Real-time] [Batch] [Backlog] [Catchup] Modes  │
│ ◆ Toggle Graceful Degradation                   │
│ ◆ Manual Override (Expert Mode)                 │
└─────────────────────────────────────────────────┘
```

### 5.3 Control Plane API

**Operator Endpoints**:

```typescript
// GET /admin/indexer/status
{
  ledgersBehind: 5,
  processingRate: 1200,
  loadLevel: 'NORMAL',
  backpressure: 0.15,
  adaptivePollingInterval: 450,
  workerCounts: {
    ingester: 4,
    decoder: 4,
    enrichment: 4,
    analytics: 2
  },
  queueDepths: { raw: 200, decoded: 150, enriched: 100 },
  prediction: { horizon: 5, throughput: 450, confidence: 0.92 }
}

// POST /admin/indexer/mode
{
  mode: 'realtime' | 'balanced' | 'backlog' | 'catchup'
}

// POST /admin/indexer/degradation
{
  level: 'NORMAL' | 'MODERATE' | 'HIGH' | 'CRITICAL',
  override: true // bypass auto-evaluation
}

// GET /admin/indexer/predictions
{
  model: 'lstm-v2',
  trained: '2026-07-10T00:00:00Z',
  rmse: 0.12,
  nextRetrain: '2026-07-17T00:00:00Z',
  recent: [
    { timestamp: '2026-07-16T14:30:00Z', predicted: 450, actual: 480, error: 0.067 },
    ...
  ]
}

// GET /admin/cost-analytics
{
  costPerLedger: 0.0001,
  costPerTx: 0.00005,
  optimalWorkerCount: 6,
  currentWorkerCount: 8,
  estimatedMonthlySavings: 2400
}
```

---

## Backpressure & Flow Control

### Algorithm: Adaptive Backpressure

```typescript
async function propagateBackpressure() {
  // Monitor downstream queue depths
  const depths = {
    decodedTxs: await nats.getQueueDepth('decoded-transactions'),
    enrichedEvents: await nats.getQueueDepth('enriched-events'),
    database: await db.getPendingWriteCount()
  };
  
  // Calculate bottleneck
  const maxDepth = 10000;
  const bottleneck = Math.max(
    depths.decodedTxs / maxDepth,
    depths.enrichedEvents / maxDepth,
    depths.database / 1000
  );
  
  // Adjust ingestion rate
  if (bottleneck > 0.8) {
    // Aggressive slowdown
    pollingInterval = Math.min(pollingInterval * 2, MAX_INTERVAL);
    batchSize = 1;
  } else if (bottleneck > 0.5) {
    // Moderate slowdown
    pollingInterval = Math.min(pollingInterval * 1.3, MAX_INTERVAL);
    batchSize = Math.max(batchSize / 2, 1);
  } else if (bottleneck < 0.2) {
    // Can accelerate
    pollingInterval = Math.max(pollingInterval / 1.2, MIN_INTERVAL);
    batchSize = Math.min(batchSize * 1.5, MAX_BATCH);
  }
}
```

---

## Data Models & State Management

### New Database Tables

```sql
-- Adaptive polling state
CREATE TABLE adaptive_polling_state (
  id SERIAL PRIMARY KEY,
  polling_interval_ms INT NOT NULL,
  batch_size INT NOT NULL,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  ema_interval_ms INT NOT NULL -- exponential moving average
);

-- Predictive model versions
CREATE TABLE prediction_models (
  id SERIAL PRIMARY KEY,
  model_type VARCHAR(50) NOT NULL, -- 'lstm-v2'
  version INT NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL,
  rmse DECIMAL(5, 4) NOT NULL,
  features JSONB NOT NULL, -- feature configuration
  weights_url TEXT NOT NULL, -- S3 path to model
  is_active BOOLEAN DEFAULT FALSE,
  deployed_at TIMESTAMPTZ
);

-- Prediction history for accuracy tracking
CREATE TABLE predictions (
  id BIGSERIAL PRIMARY KEY,
  model_id INT REFERENCES prediction_models(id),
  timestamp TIMESTAMPTZ NOT NULL,
  horizon_minutes INT NOT NULL,
  predicted_throughput DECIMAL(10, 2) NOT NULL,
  actual_throughput DECIMAL(10, 2),
  confidence DECIMAL(5, 4) NOT NULL,
  error_rate DECIMAL(5, 4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Load degradation events
CREATE TABLE degradation_events (
  id BIGSERIAL PRIMARY KEY,
  load_level VARCHAR(20) NOT NULL, -- 'NORMAL', 'MODERATE', 'HIGH', 'CRITICAL'
  triggered_at TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  reason VARCHAR(255),
  skipped_events_count INT,
  backfill_queue_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skipped ledgers for backfill
CREATE TABLE skipped_ledgers (
  id BIGSERIAL PRIMARY KEY,
  ledger_id BIGINT NOT NULL UNIQUE,
  reason VARCHAR(50) NOT NULL, -- 'load_shedding', 'sampling'
  priority_level VARCHAR(5) NOT NULL, -- 'P0', 'P1', 'P2', 'P3'
  sampled_at TIMESTAMPTZ NOT NULL,
  backfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Control plane settings
CREATE TABLE control_plane_overrides (
  id SERIAL PRIMARY KEY,
  setting_name VARCHAR(100) NOT NULL UNIQUE,
  setting_value JSONB NOT NULL,
  reason TEXT,
  operator_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
```

---

## Deployment & Operations

### Prerequisites
1. NATS cluster (3+ nodes, JetStream enabled)
2. Kubernetes 1.24+ with custom metrics API
3. ML model serving (optional: Seldon/BentoML for hot model swaps)
4. Prometheus & Grafana for monitoring

### Deployment Steps

1. **Deploy NATS Infrastructure**:
   ```bash
   helm install nats nats/nats-server \
     --set jetstream.enabled=true \
     --set cluster.replicas=3
   ```

2. **Deploy Indexer Components** (in order):
   - Ingester workers (1 stateful set)
   - Decoder workers (auto-scaling deployment)
   - Enrichment workers (auto-scaling deployment)
   - Analytics workers (optional, auto-scaling)
   - Predictor service (1 singleton)
   - Control plane API (1 deployment, 2 replicas)

3. **Configure HPA**: Apply custom metrics for auto-scaling

4. **Deploy Monitoring**: Grafana dashboard + Prometheus rules

### Migration Path (Backward Compatibility)

**Phase 1** (Week 1): Deploy NATS + new workers alongside existing indexer
**Phase 2** (Week 2): Migrate 10% traffic to NATS pipeline
**Phase 3** (Week 3): Migrate 50% traffic
**Phase 4** (Week 4): Full cutover, deprecate old indexer

---

## Success Criteria & Acceptance Tests

| Criterion | Target | Test Method |
|-----------|--------|-------------|
| **Lag at 99th percentile** | <5s | Load test with 500+ tx/s for 1 hour |
| **Pre-scaling accuracy** | 90% of spikes detected 2+ min early | Review prediction logs vs actual |
| **Prediction RMSE** | <15% | Model accuracy on test set |
| **10x load handling** | No OOM kills, graceful degradation | Spike load to 5000 tx/s, verify pod stability |
| **Backfill completeness** | 100% of skipped events recovered | Verify `skipped_ledgers` emptied post-recovery |
| **Operator control** | Manual overrides work reliably | Test all control plane endpoints |

---

## References & Related Docs
- [INDEXER_IMPLEMENTATION_SUMMARY.md](INDEXER_IMPLEMENTATION_SUMMARY.md)
- [Monitoring Guide](health-checks.md)
- [NATS JetStream Documentation](https://docs.nats.io/nats-concepts/jetstream)
- [Kubernetes HPA Documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
