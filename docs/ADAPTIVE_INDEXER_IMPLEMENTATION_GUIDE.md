# Adaptive Indexer Implementation Guide

## Quick Start

### 1. Install Dependencies

```bash
npm install nats @tensorflow/tfjs-node
```

### 2. Database Migration

```bash
# Run migration to create new tables
psql -d soroban_db -f prisma/migrations/adaptive_indexer_20260716.sql

# Or using Prisma
npx prisma migrate deploy
```

### 3. Configure NATS Cluster

```bash
# Create NATS helm values
cat > nats-values.yaml << EOF
jetstream:
  enabled: true
  memoryStore:
    maxMemory: "2Gi"
  fileStore:
    maxSize: "10Gi"
cluster:
  replicas: 3
  nodeselector: {}
replicaCount: 3
EOF

# Install NATS
helm install nats nats/nats-server -f nats-values.yaml --namespace soroban
```

### 4. Deploy Indexer Components

```bash
# Apply Kubernetes manifests
kubectl apply -f k8s/adaptive-indexer-deployment.yaml

# Verify deployments
kubectl get deployments -n soroban | grep indexer
```

### 5. Run Integration Tests

```bash
npm run test -- tests/adaptive-indexer-integration.test.ts
```

---

## Component Integration

### Using Adaptive Polling

```typescript
import { getAdaptivePollingService } from './src/indexer/adaptive-polling';

async function mainIndexerLoop() {
  const pollingService = getAdaptivePollingService();
  await pollingService.recoverState(); // Recover from previous state

  const metrics = {
    ledgersBehind: await getLedgersBehind(),
    processingQueueDepth: await getNatsQueueDepth(),
    availableWorkers: 4,
    processingRate: 200
  };

  // Calculate next interval adaptively
  const nextInterval = await pollingService.calculateNextInterval(metrics);
  const batchSize = pollingService.calculateBatchSize(metrics);
  const processingMode = pollingService.getProcessingMode(metrics);

  console.log(`Next interval: ${nextInterval}ms, batch size: ${batchSize}, mode: ${processingMode}`);

  // Sleep for adaptive interval
  await sleep(nextInterval);

  // Process ledgers in optimal batch size
  const ledgers = await fetchLedgers(batchSize);
  await processLedgers(ledgers);
}
```

### Using Predictive Model

```typescript
import { getPredictiveModelService } from './src/indexer/predictive-model';

async function predictiveScaling() {
  const modelService = await getPredictiveModelService();

  // Make predictions for different time horizons
  const prediction5m = await modelService.predict(5);
  const prediction15m = await modelService.predict(15);

  console.log(`5m prediction: ${prediction5m.predictedThroughput} tx/s (confidence: ${prediction5m.confidence})`);
  console.log(`Scaling action: ${prediction5m.scalingAction}, required workers: ${prediction5m.requiredWorkers}`);

  // If high activity predicted, pre-scale workers
  if (prediction5m.scalingAction === 'scale_up' && prediction5m.requiredWorkers) {
    await scaleWorkers(prediction5m.requiredWorkers);
  }
}
```

### Using Graceful Degradation

```typescript
import { getGracefulDegradationService, LoadLevel } from './src/indexer/graceful-degradation';

async function handleLoadSpike() {
  const degradationService = getGracefulDegradationService();

  const metrics = {
    queueDepth: 25000,
    ledgersBehind: 150,
    memoryUsagePercent: 90,
    cpuUsagePercent: 85,
    activeWorkers: 8
  };

  const loadLevel = degradationService.evaluateLoadLevel(metrics);

  // Apply degradation if needed
  await degradationService.applyDegradation(loadLevel);

  const config = degradationService.getConfig();

  // Use degraded config in event processing
  for (const event of events) {
    // Always process P0 (watchlisted)
    if (!degradationService.shouldProcessEvent(event.priority)) {
      // Track for backfill
      await degradationService.recordSkippedLedger(event.ledgerId, 'load_shedding', event.priority);
      continue;
    }

    // Apply degradation rules
    if (!config.enableComposability) {
      // Skip composability analysis
      event.composabilityAnalysis = null;
    }

    if (!config.enableMevClassification) {
      // Skip MEV classification
      event.mevScore = null;
    }

    await processEvent(event);
  }
}
```

### Using NATS Message Queue

```typescript
import { getNATSQueueService, RawLedgerMessage } from './src/indexer/nats-queue';

// Ingester worker: publish raw ledgers
async function ingesterWorker() {
  const natsQueue = await getNATSQueueService();

  const ledger: RawLedgerMessage = {
    ledgerId: 12345,
    closeTime: Date.now(),
    xdr: 'base64-encoded-xdr-data',
    hash: 'ledger-hash',
    timestamp: Date.now()
  };

  await natsQueue.publishRawLedger(ledger);
}

// Decoder worker: consume raw ledgers, publish decoded
async function decoderWorker() {
  const natsQueue = await getNATSQueueService();

  await natsQueue.subscribeToRawLedgers(async (msg) => {
    const decoded = decodeXDR(msg.xdr);

    await natsQueue.publishDecodedTransaction({
      ledgerId: msg.ledgerId,
      txId: decoded.id,
      source: decoded.source,
      operations: decoded.operations,
      sorobanEvents: decoded.events,
      timestamp: Date.now()
    });
  });
}

// Enrichment worker: consume decoded, publish enriched
async function enrichmentWorker() {
  const natsQueue = await getNATSQueueService();

  await natsQueue.subscribeToDecodedTransactions(async (msg) => {
    const enriched = await enrichEvents(msg.sorobanEvents);

    await natsQueue.publishEnrichedEvent({
      ledgerId: msg.ledgerId,
      eventId: enriched.id,
      contract: enriched.contractId,
      eventType: enriched.type,
      mevScore: enriched.mevScore,
      composabilityAnalysis: enriched.composability,
      relatedContracts: enriched.related,
      priority: getPriority(enriched.contractId),
      timestamp: Date.now()
    });
  });
}

// Monitor queue depth for backpressure
async function monitorBackpressure() {
  const natsQueue = await getNATSQueueService();

  setInterval(async () => {
    const depths = await natsQueue.getAllQueueDepths();
    console.log('Queue depths:', depths);

    // Apply backpressure if needed
    const maxDepth = Math.max(...Object.values(depths));
    if (maxDepth > 20000) {
      console.warn('High queue depth, triggering backpressure');
      // Slow down ingestion
    }
  }, 10000);
}
```

### Control Plane API

```bash
# Get current status
curl http://localhost:3000/admin/indexer/status

# Set processing mode
curl -X POST http://localhost:3000/admin/indexer/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode": "catchup"}'

# Manually apply degradation
curl -X POST http://localhost:3000/admin/indexer/degradation \
  -H 'Content-Type: application/json' \
  -d '{"level": "HIGH", "override": false}'

# Trigger backfill
curl -X POST http://localhost:3000/admin/indexer/backfill

# Get model metrics
curl http://localhost:3000/admin/indexer/predictions

# Cost analytics
curl http://localhost:3000/admin/indexer/cost-analytics
```

---

## Monitoring & Observability

### Key Metrics to Track

1. **Lag Metrics**
   - `soroban_indexer_ledgers_behind` - Critical for SLA
   - `soroban_indexer_processing_rate` - Throughput in tx/s

2. **Polling Metrics**
   - `soroban_indexer_polling_interval_ms` - Current adaptive interval
   - `soroban_indexer_batch_size` - Current batch size

3. **Queue Metrics**
   - `nats_queue_depth` - Messages awaiting processing
   - `nats_throughput` - Processing rate per stage

4. **Degradation Metrics**
   - `soroban_degradation_level` - Current load level
   - `soroban_skipped_events_total` - Events sampled/skipped

5. **Prediction Metrics**
   - `predictor_rmse` - Model accuracy
   - `predictor_accuracy_rate` - % within 20% error

### Grafana Dashboard

Create a Grafana dashboard with:

```json
{
  "dashboard": {
    "title": "Adaptive Indexer",
    "panels": [
      {
        "title": "Ledgers Behind (SLA)",
        "targets": [{"expr": "soroban_indexer_ledgers_behind"}],
        "alert": {"le": 5}
      },
      {
        "title": "Processing Rate",
        "targets": [{"expr": "soroban_indexer_processing_rate"}]
      },
      {
        "title": "Adaptive Polling Interval",
        "targets": [{"expr": "soroban_indexer_polling_interval_ms"}]
      },
      {
        "title": "Queue Depths",
        "targets": [
          {"expr": "nats_queue_depth{topic='raw-ledgers'}"},
          {"expr": "nats_queue_depth{topic='decoded-transactions'}"},
          {"expr": "nats_queue_depth{topic='enriched-events'}"}
        ]
      },
      {
        "title": "Degradation Level",
        "targets": [{"expr": "soroban_degradation_level"}]
      },
      {
        "title": "Model RMSE",
        "targets": [{"expr": "predictor_rmse"}],
        "alert": {"gt": 0.15}
      }
    ]
  }
}
```

### Alerting Rules

```yaml
groups:
  - name: adaptive-indexer
    rules:
      - alert: LagExceeded
        expr: soroban_indexer_ledgers_behind > 5
        for: 1m
        annotations:
          summary: Indexer lag exceeded SLA

      - alert: HighQueueDepth
        expr: nats_queue_depth > 30000
        for: 2m
        annotations:
          summary: Message queue backup detected

      - alert: ModelAccuracyDegraded
        expr: predictor_rmse > 0.2
        for: 5m
        annotations:
          summary: Prediction model accuracy degraded

      - alert: CriticalDegradationActive
        expr: soroban_degradation_level == 3
        for: 5m
        annotations:
          summary: Critical load degradation active
```

---

## Troubleshooting

### Issue: High RMSE (>20%)

**Cause**: Model needs retraining  
**Solution**:
```bash
# Retrain model with recent data
curl -X POST http://localhost:3000/admin/indexer/model-retrain \
  -H 'Content-Type: application/json' \
  -d '{"hours_of_data": 168}'
```

### Issue: Lag not decreasing despite scaling

**Cause**: Bottleneck in downstream stages (decoder or enrichment)  
**Solution**:
```bash
# Check which stage is bottlenecked
curl http://localhost:3000/admin/indexer/status | jq .queueDepths

# Scale specific worker type
kubectl scale deployment indexer-enrichment --replicas=16 -n soroban
```

### Issue: Memory usage increasing

**Cause**: Skipped ledgers queue growing without backfill  
**Solution**:
```bash
# Trigger manual backfill
curl -X POST http://localhost:3000/admin/indexer/backfill

# Or lower load level temporarily
curl -X POST http://localhost:3000/admin/indexer/degradation \
  -H 'Content-Type: application/json' \
  -d '{"level": "MODERATE", "override": true}'
```

### Issue: NATS connection drops

**Cause**: Network issue or NATS cluster degraded  
**Solution**:
```bash
# Check NATS cluster health
kubectl get pods -n nats -l app=nats

# Check connectivity
kubectl exec -it indexer-ingester-0 -- \
  nc -zv nats-cluster-0.nats.soroban.svc.cluster.local 4222
```

---

## Performance Tuning

### Optimal Configuration by Network Load

#### Light Load (<100 tx/s)
```yaml
minInterval: 2000ms
maxInterval: 5000ms
batchSize: 1
enableComposability: true
enableAnalytics: true
```

#### Moderate Load (100-300 tx/s)
```yaml
minInterval: 500ms
maxInterval: 3000ms
batchSize: 5
enableComposability: true
enableAnalytics: true
```

#### High Load (300-800 tx/s)
```yaml
minInterval: 100ms
maxInterval: 2000ms
batchSize: 10
enableComposability: false
enableAnalytics: true
```

#### Extreme Load (>800 tx/s)
```yaml
minInterval: 50ms
maxInterval: 500ms
batchSize: 20
enableComposability: false
enableAnalytics: false
gracefulDegradation: Level 2-3
```

---

## Migration from Fixed Polling

### Phase 1: Deploy Alongside (Week 1)
- Deploy new NATS-based indexer components
- Set traffic split to 0% (no processing yet)
- Verify health checks pass

### Phase 2: Canary (Week 2)
- Route 10% of ledgers to new pipeline
- Monitor lag, error rates, accuracy
- Adjust configs based on performance

### Phase 3: Gradual Ramp (Weeks 3-4)
- 25% → 50% → 75% → 100% traffic migration
- Monitor side-by-side performance
- Keep old indexer as fallback

### Phase 4: Cleanup (Week 5+)
- Fully deprecate old indexer
- Archive old tables (keep 30 days of history)
- Sunset old monitoring

---

## Success Metrics Validation

```typescript
// Test script to validate success criteria
async function validateSuccessCriteria() {
  const tests = {
    // Criterion 1: Lag at 99th percentile < 5s
    lagTest: async () => {
      const lag = await getP99Lag();
      console.assert(lag < 5000, `Lag ${lag}ms exceeds 5s target`);
    },

    // Criterion 2: Pre-scaling accuracy > 90%
    scalingAccuracyTest: async () => {
      const accuracy = await getScalingAccuracy();
      console.assert(accuracy > 0.9, `Scaling accuracy ${accuracy} below 90%`);
    },

    // Criterion 3: Prediction RMSE < 15%
    rmseTest: async () => {
      const rmse = await getModelRMSE();
      console.assert(rmse < 0.15, `RMSE ${rmse} exceeds 15% threshold`);
    },

    // Criterion 4: Handle 10x load without OOM
    stressTest: async () => {
      const result = await simulateLoad(10);
      console.assert(result.outOfMemoryEvents === 0, 'OOM kills detected during 10x load');
      console.assert(result.gracefulDegradationActive, 'Degradation not triggered at 10x load');
    }
  };

  for (const [test, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`✓ ${test} PASSED`);
    } catch (error) {
      console.error(`✗ ${test} FAILED:`, error);
    }
  }
}
```

---

## Next Steps

1. Deploy NATS cluster in your Kubernetes environment
2. Run database migrations
3. Deploy indexer components using provided manifests
4. Configure Prometheus + Grafana monitoring
5. Train predictive model with your historical data
6. Gradually migrate traffic from old indexer
7. Monitor metrics against success criteria

For questions or issues, refer to [ADAPTIVE_INDEXER_DESIGN.md](ADAPTIVE_INDEXER_DESIGN.md) for architectural details.
