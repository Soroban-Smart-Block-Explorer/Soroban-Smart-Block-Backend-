# Soroban Smart Block Backend - Indexer Implementation Summary

## Overview
The indexer is a sophisticated, real-time blockchain event processor that continuously monitors the Stellar Soroban network for ledger updates, transactions, and smart contract events. It employs a hybrid polling + WebSocket architecture with parallel batch processing, reorg detection, and comprehensive error handling.

---

## 1. Entry Point and Polling Mechanism

### Main Entry Points
- **Primary**: `src/index.ts` → `startIndexerService()` (called during application startup)
- **Core Worker**: `src/indexer/indexer.ts` → `SorobanEventWorker` class
- **Alternative**: `src/indexer/run.ts` (standalone indexer entry point for direct invocation)

### Polling Mechanism

**Architecture**: Hybrid WebSocket + Polling

1. **WebSocket Live-Tail** (`connectWebsocket()`)
   - Connects to Soroban RPC WebSocket at `config.stellarRpcWsUrl`
   - Subscribes to `ledger` topic for real-time ledger close events
   - Triggers `onLedgerClose()` when new ledgers arrive
   - Auto-reconnect with exponential backoff (max 30s delay)
   - Graceful reconnect handling on network failures

2. **Polling Loop** (`start()`)
   - Runs indefinitely with configurable `indexerPollIntervalMs` (default: 5000ms)
   - Calls `getLatestLedger()` to fetch current network height
   - Invokes `syncToLatest(targetLedger)` to process missing ledgers
   - Prevents concurrent processing with `isProcessing` flag

### Configuration Parameters
```typescript
- INDEXER_POLL_INTERVAL_MS: 5000 (milliseconds between polls)
- INDEXER_START_LEDGER: 0 (first ledger to process)
- INDEXER_BATCH_SIZE: 100 (ledgers per processing batch)
- INDEXER_CATCHUP_WORKERS: 4 (concurrent workers for catch-up)
```

### State Management
- **IndexerState** (Prisma model): Singleton record storing `lastLedger` (last processed ledger sequence)
- Located in database with id='singleton'
- Updated atomically after all workers complete successfully
- Enables safe crash recovery

---

## 2. Ledger Processing

### Processing Flow

```
getLatestLedger()
    ↓
syncToLatest(targetLedger)
    ├─→ [SINGLE LEDGER PATH] → processLedgerRange()
    └─→ [GAP PATH] → catchUp() [parallel workers]
```

### Step-by-Step Ledger Processing (`processLedgerRange()`)

1. **Metadata Fetching** (sequential)
   - `fetchLedgerMetadata(seq)` for each ledger
   - Fetches from Horizon REST API (JSON, stable structure)
   - Falls back to Soroban RPC if Horizon unavailable
   - Extracts: hash, previousLedgerHash, closeTime, txCount

2. **Reorg Detection**
   ```typescript
   if (prevLedger.hash !== ledgerMeta.previousLedgerHash) {
     // REORG DETECTED!
     await prisma.reorgEvent.create(...)
     await rollbackLedgers([prevSeq])
     throw new Error(...)
   }
   ```
   - Compares stored previous ledger hash with network-provided value
   - Records reorg event with rollback ledgers
   - Deletes affected ledgers, transactions, events, authorizations, WASM upgrades
   - Resets IndexerState.lastLedger to before reorg

3. **Ledger Record Creation** (upsert)
   - Stores Ledger with sequence (PK), hash, previousLedgerHash, closeTime, txCount
   - Creates if new, updates if exists

4. **Event Fetching** (`fetchEvents(startLedger, endLedger)`)
   - Calls `rpc.getEvents()` with contract filter
   - Handles pagination (cursor-based, 200 events per page)
   - Rate limit retry logic (exponential backoff, 6 max attempts)
   - Filters to ensure all events within [startLedger, endLedger]

5. **Transaction Processing** (for each event)
   - Creates Contract record if new (`upsert` by address)
   - Fetches transaction details via:
     - Primary: `getTransaction(hash)` (RPC)
     - Fallback: `getTransactionFromHorizon(hash)`
   - Decodes XDR if available
   - Creates/updates Transaction record with:
     - sourceAccount, contractAddress, functionName, functionArgs
     - status (success/failed), feeCharged, humanReadable
   - Triggers Account Abstraction (AA) processing (non-blocking)
   - Publishes to feed orchestrator

6. **Event Storage** (for each contract event)
   - Decodes event topics and data
   - Creates Event record with:
     - transactionHash, contractAddress, eventType
     - topics, data, decoded JSON
     - ledgerSequence, ledgerCloseTime
   - Uses paging token for unique event ID (prevents duplicates)
   - Publishes to feed orchestrator

7. **Session Authorization Processing**
   - Detects authorization events (session_authorization, authorize_session, etc.)
   - Extracts hotSigner, startLedger, expiryLedger
   - Creates SessionAuthorization record with expiry tracking

### Reorg Recovery

**ReorgEvent Model** (tracks reorgs)
```typescript
model ReorgEvent {
  id: String @id
  ledgerSequence: Int          // Where reorg detected
  expectedHash: String         // What we had stored
  actualHash: String           // What network says
  previousHash: String         // Previous hash
  rolledBackLedgers: Int[]     // Sequences deleted
}
```

**Rollback Strategy**
- Deletes in transaction order: SessionAuthorizations → Events → Transactions → WasmUpgradeHistory → Ledgers
- Ensures referential integrity
- Idempotent (upserts prevent re-insertion)

---

## 3. Batch and Queue Processing

### Parallel Catch-Up (`catchUp()`)

**Purpose**: When indexer lags significantly behind, process multiple ledger ranges concurrently

**Algorithm**:
```typescript
function chunkRange(from: number, to: number, n: number): Array<[number, number]>
```
- Splits [from, to] range into up to `n` equal-sized chunks
- Each worker processes non-overlapping chunk independently
- All chunks run in parallel via `Promise.all()`

**Execution**:
```typescript
const chunks = chunkRange(from, to, WORKERS)  // e.g., 4 chunks
await Promise.all(chunks.map(([s, e]) => processLedgerRange(s, e)))
await setLastIndexedLedger(to)  // Atomic state update
```

**Key Property**: Upserts are idempotent, so partial failure leaves cursor unchanged; retry retries entire round

### Gap Detection and Backfill

**Detection** (`syncToLatest()`)
```typescript
if (last < targetLedger - 1) {
  // GAP EXISTS
  const gapStart = last + 1
  const gapEnd = targetLedger - 1
  // Record in LedgerGap table
}
```

**LedgerGap Model** (tracks missing ledger ranges)
```typescript
model LedgerGap {
  id: String @id
  startSequence: Int
  endSequence: Int
  resolved: Boolean  // false = in-progress, true = complete
}
```

**Backfill Strategy**:
- If gap size ≥ BATCH_SIZE and WORKERS > 1: Use parallel `catchUp()`
- Otherwise: Sequential `processLedgerRange()`
- Mark gap as `resolved: true` after backfill succeeds
- If backfill fails: leaves gap as `resolved: false` for retry

### Dead-Letter Queue (Error Handling)

**FailedItem Model** (persists failed items for retry)
```typescript
model FailedItem {
  id: String @id
  itemType: String              // 'transaction' | 'event'
  itemId: String
  ledger: Int
  rawXdr: String?
  errorMsg: String
  errorStack: String?
  retryCount: Int               // 0, 1, 2, ...
  dead: Boolean                 // true if retryCount >= MAX_RETRIES (3)
  createdAt: DateTime
  lastTriedAt: DateTime
}
```

**Enqueue Logic** (`enqueueFailure()`)
```typescript
// On failure during event/transaction processing:
await enqueueFailure({
  itemType: 'event',
  itemId: eventId,
  ledger: sequence,
  error: err
})
```
- Idempotent: increments `retryCount` if already exists
- Marks as `dead` if retries exhausted (MAX_RETRIES = 3)

**Retry Logic** (`retryFailures(handler)`)
```typescript
const pending = await prisma.failedItem.findMany({
  where: { dead: false }
})
for (const item of pending) {
  try {
    await handler(item)
    await prisma.failedItem.delete(...)  // Success: remove
  } catch {
    await enqueueFailure(...)  // Failure: re-queue
  }
}
```

---

## 4. Metrics and Monitoring

### Prometheus Metrics (via `prom-client`)

**Indexer-Specific Metrics**:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `indexer_last_ledger` | Gauge | - | Last processed ledger sequence |
| `indexer_ingestion_lag_ledgers` | Gauge | - | Ledgers behind chain tip |
| `indexer_ledgers_processed_total` | Counter | - | Cumulative ledgers processed |
| `indexer_ledger_processing_duration_seconds` | Histogram | - | Time to process batch (buckets: 0.1s-30s) |
| `indexer_errors_total` | Counter | `type` | Errors by category (reorg, network, etc.) |

**Database Metrics**:
- `db_query_duration_seconds` (Histogram, labeled by operation)
- `db_connection_status` (Gauge: 1=healthy, 0=unhealthy)

**Cache Metrics**:
- `cache_backend_status` (Gauge: 1=Redis, 0=in-memory fallback)

**HTTP Request Metrics**:
- `http_request_duration_seconds` (Histogram)
- `http_requests_total` (Counter)
- `http_errors_total` (Counter)
- `http_5xx_surge_ratio` (Gauge)

**Replica Lag Metrics**:
- `replica_lag_check_errors_total` (Counter)

### Health Endpoints

1. **`GET /health`** - Comprehensive health with dependency status
   - Returns 503 if any dependency unhealthy
   - Includes network, database, cache, indexer status

2. **`GET /livez`** - Kubernetes liveness probe
   - Basic check: service process is alive
   - Returns 503 if shutting down

3. **`GET /readyz`** - Kubernetes readiness probe
   - Detailed check: service can handle traffic
   - Tests all dependencies (cache, DB, indexer)
   - Returns 503 if not ready

4. **`GET /ready`** - Legacy readiness (monitors indexer health)
   - Returns 503 if indexer suffered fatal failure
   - Includes disabled services list

### Indexer Health State

```typescript
// In indexer-state.ts
setIndexerFailed(reason)   // Call on fatal error
setIndexerHealthy()        // Call on recovery
getIndexerStatus()         // Returns { healthy, failureReason? }
```

---

## 5. Worker and Scaling Configuration

### Enabled Services

**Core Services** (always enabled if DISABLE_INDEXER not set):

1. **Indexer Service** (`SorobanEventWorker`)
   - WebSocket connection + polling loop
   - Ledger processing and gap backfill
   - Optional: `INDEXER_START_LEDGER` to resume from checkpoint

2. **Bridge Worker** (enabled by default)
   - `startBridgeWorker()` in `src/bridge-tracker/worker.ts`
   - Monitors cross-chain bridge transactions
   - Tracks bridge finality and alerts

3. **Price Updater** (enabled by default)
   - `startPriceUpdater()` in `src/services/pricing/index.ts`
   - Continuously updates token prices
   - Feeds price data to analytics

**Optional Services** (feature flags):

| Service | Environment Variable | Default | Purpose |
|---------|----------------------|---------|---------|
| Pool Price Monitor | `ENABLE_POOL_MONITOR` | false | Polls DEX pools every 2.5s, computes TWAP |
| Arbitrage Scanner | `ENABLE_ARBITRAGE_SCANNER` | false | Detects arbitrage opportunities (1s scan interval) |
| Fee Aggregator | `ENABLE_FEE_AGGREGATOR` | false | Aggregates fee metrics |
| Privacy WebSocket | `ENABLE_PRIVACY_WS` | false | Broadcasts privacy events |
| Composability WebSocket | `ENABLE_COMPOSABILITY_WS` | false | Broadcasts composability events |
| Arbitrage WebSocket | `ENABLE_ARBITRAGE_WS` | false | Broadcasts arbitrage opportunities |

### Concurrency Configuration

```typescript
// From config.ts
INDEXER_CATCHUP_WORKERS: 1-32 (default: 4)
  → Controls parallel workers during gap catch-up
  
INDEXER_BATCH_SIZE: 1-1000 (default: 100)
  → Ledgers per processing chunk
  
INDEXER_POLL_INTERVAL_MS: 100+ ms (default: 5000)
  → Delay between polling cycles
```

### Service Lifecycle

**Startup** (`main()` in `index.ts`):
1. Connect to database
2. Initialize cache (Redis or in-memory)
3. Validate state dump path (for graceful shutdown)
4. Start indexer service
5. Attach WebSocket servers
6. Initialize optional services
7. Start HTTP server

**Shutdown** (SIGTERM/SIGINT):
1. Set `isShuttingDown = true`
2. Stop indexer service
3. Close WebSocket connections
4. Stop bridge worker, price updater, feed orchestrator
5. Save shutdown state to `/tmp/state/shutdown-state.json`
6. Disconnect databases
7. Exit (force after SHUTDOWN_TIMEOUT_MS = 30s)

---

## 6. Database Schema (Indexer-Related)

### Core Ledger Models

```typescript
model Ledger {
  sequence           Int @id
  hash               String @unique
  previousLedgerHash String?
  closeTime          DateTime
  txCount            Int @default(0)
  
  transactions Transaction[]
  events       Event[]
  
  @@index([sequence])
  @@index([closeTime])
}

model Transaction {
  id               String @id
  hash             String @unique
  ledgerSequence   Int
  ledgerCloseTime  DateTime
  sourceAccount    String
  contractAddress  String?
  functionName     String?
  functionArgs     Json?
  rawXdr           String
  status           String           // 'success' | 'failed'
  feeCharged       String?
  sorobanResources Json?
  
  ledger   Ledger    @relation(...)
  contract Contract? @relation(...)
  events   Event[]
  
  @@index([ledgerSequence])
  @@index([contractAddress])
  @@index([status])
  // ... more indexes for queries
}

model Event {
  id              String @id
  transactionHash String
  contractAddress String
  eventType       String
  topicSymbol     String?
  topics          Json
  data            Json
  decoded         Json?
  ledgerSequence  Int
  ledgerCloseTime DateTime
  
  ledger      Ledger
  transaction Transaction
  contract    Contract
  
  @@index([contractAddress])
  @@index([ledgerSequence])
  @@index([eventType])
  // ... more indexes
}

model Contract {
  id               String @id
  address          String @unique
  abi              Json?
  functionSignatures Json?
  isToken          Boolean
  tokenSymbol      String?
  wasmHash         String?
  
  transactions Transaction[]
  events       Event[]
  wasmUpgrades WasmUpgradeHistory[]
  
  @@index([address])
}

model WasmUpgradeHistory {
  id              String @id
  contractAddress String
  previousHash    String?
  newHash         String
  ledgerSequence  Int
  ledgerCloseTime DateTime
  transactionHash String?
  
  contract Contract @relation(...)
  
  @@index([contractAddress, ledgerSequence])
  @@index([isSuspicious])
}
```

### Indexer State Models

```typescript
model IndexerState {
  id         String @id @default("singleton")
  lastLedger Int @default(0)
  updatedAt  DateTime @updatedAt
}

model ReorgEvent {
  id                String @id
  ledgerSequence    Int
  detectedAt        DateTime @default(now())
  expectedHash      String
  actualHash        String
  previousHash      String
  rolledBackLedgers Int[]
}

model LedgerGap {
  id             String @id
  startSequence  Int
  endSequence    Int
  detectedAt     DateTime @default(now())
  resolved       Boolean @default(false)
}

model FailedItem {
  id          String @id
  itemType    String           // 'transaction' | 'event'
  itemId      String
  ledger      Int
  rawXdr      String?
  errorMsg    String
  errorStack  String?
  retryCount  Int @default(0)
  dead        Boolean @default(false)
  createdAt   DateTime @default(now())
  lastTriedAt DateTime @default(now())
  
  @@index([itemType, dead])
  @@index([ledger])
}
```

### Related Models (Auth, Etc.)

```typescript
model SessionAuthorization {
  id                String @id
  eventId           String @unique
  contractAddress   String
  hotSigner         String?
  authorizationType String
  startLedger       Int
  expiryLedger      Int
  allocatedBlocks   Int
  
  @@index([contractAddress])
  @@index([expiryLedger])
}
```

### Database Indexes

**Critical for Indexer Performance**:
- `Ledger(sequence)` - Primary key lookup
- `Ledger(closeTime)` - Time-based queries
- `Transaction(ledgerSequence)` - Ledger-scoped queries
- `Transaction(contractAddress)` - Contract queries
- `Event(ledgerSequence)` - Ledger-scoped event queries
- `Event(contractAddress)` - Contract event queries
- `FailedItem(itemType, dead)` - Dead-letter queue scan

---

## 7. Message Queues and Event Pub/Sub Systems

### Event Broadcasting (WebSocket)

**File**: `src/ws/eventBroadcaster.ts`

**Architecture**:
```
In-memory Set<Client>
    ↓
broadcastEvent(event) → filters & sends to all matched clients
```

**Client Filtering**:
```typescript
interface Client {
  ws: WebSocket
  contractFilter: string | null    // e.g., "CXX..." or null (all)
  eventTypeFilter: string | null   // e.g., "token_transfer" or null
}
```

**Query Parameters**:
- `?contract=CXXX...` - Filter by contract address
- `?eventType=token_transfer` - Filter by event type
- Both optional; null means no filtering

**Broadcast Logic**:
```typescript
export function broadcastEvent(event) {
  for (const client of clients) {
    if (!matchesFilter(client, event)) continue
    client.ws.send(JSON.stringify({ type: 'event', data: event }))
  }
}
```

**Event Messages**:
```json
{
  "type": "event",
  "data": {
    "id": "event-id",
    "contractAddress": "CXXX...",
    "eventType": "token_transfer",
    "decoded": {...},
    "ledger": 12345,
    "ledgerCloseTime": "2024-01-15T10:00:00Z",
    "transactionHash": "..."
  }
}
```

### Feed Orchestrator (Multi-Channel Pub/Sub)

**File**: `src/feed/orchestrator.ts`

**Purpose**: Decouple ledger processing from real-time consumers (WebSocket, SSE, webhooks)

**Architecture**:
```
Indexer (processLedgerRange)
    ↓
publishTransaction() / publishEvent()
    ↓
feedPublisher (channels)
    ↓
distributeMessage()
    ├→ SubscriptionManager (get active subscriptions)
    ├→ DeliveryService (async delivery to subscribers)
    ├→ WebSocketServer (broadcast to WS clients)
    └→ EventEmitter (emit for SSE handlers)
```

**Channels**:
- `transactions` - All transaction events
- `events` - All smart contract events

**Message Structure**:
```typescript
interface FeedMessage {
  channelName: string        // 'transactions' | 'events'
  data: {
    type: string             // 'transaction' | 'event'
    schemaVersion: number    // 1
    // ... channel-specific fields
  }
  ledgerSequence: number
  timestamp: Date
  sequence?: number          // Monotonically increasing
}
```

**Publishing** (from indexer):
```typescript
await feedOrchestrator.publishTransaction({
  hash, ledgerSequence, ledgerCloseTime, sourceAccount,
  status, feeCharged, ...
})

await feedOrchestrator.publishEvent({
  id, transactionHash, contractAddress, eventType,
  topicSymbol, decoded, ledgerSequence, ledgerCloseTime
})
```

**Subscription Management**:
- Stores subscriptions in database
- Tracks delivery status per subscription
- Supports multiple transport layers (WebSocket, HTTP, Webhook)

### Specialized WebSocket Broadcasters

**1. Privacy Events** (`src/ws/privacyBroadcaster.ts`)
- Broadcasts privacy-related events
- Optional: `ENABLE_PRIVACY_WS`

**2. Composability Events** (`src/ws/composabilityBroadcaster.ts`)
- Broadcasts composability analysis
- Optional: `ENABLE_COMPOSABILITY_WS`

**3. Arbitrage Opportunities** (`src/ws/arbitrageBroadcaster.ts`)
- Real-time arbitrage detection results
- Optional: `ENABLE_ARBITRAGE_WS`
- Message format:
```json
{
  "id": "opp-id",
  "pair": "BTC/USD",
  "profitPercentage": 0.5,
  "mevScore": 85,
  "type": "direct" | "triangular" | "multi_hop",
  "route": ["CXXX...", "CYYY...", ...],
  "detectedAt": "2024-01-15T10:00:00Z",
  "buyDex": "Phoenix",
  "sellDex": "Orca"
}
```

### No Traditional Message Brokers

**Not Used**:
- ❌ RabbitMQ
- ❌ Apache Kafka
- ❌ BullMQ / Bull (Redis-backed job queue)
- ❌ AWS SQS / SNS
- ❌ Azure Service Bus

**Rationale**: 
- In-memory Sets for WebSocket clients
- Prisma for persistent delivery tracking
- EventEmitter for internal event propagation
- Suitable for single-instance deployment model

---

## 8. Key Architectural Patterns

### Pattern 1: WebSocket-Driven Event Loop

```typescript
while (!shouldStop) {
  if (isProcessing) await sleep(pollInterval)
  
  const latest = await getLatestLedger()
  await syncToLatest(latest)
  
  // WebSocket triggers onLedgerClose() asynchronously
}
```

**Benefit**: Real-time responsiveness + graceful backfill

### Pattern 2: Idempotent Upserts

```typescript
await prisma.ledger.upsert({
  where: { sequence: seq },
  update: { ... },
  create: { ... }
})
```

**Benefit**: Safe retries; partial failures don't require rollback

### Pattern 3: Atomic Ledger Batch State Update

```typescript
await Promise.all(chunks.map(processLedgerRange))
await setLastIndexedLedger(to)  // Only after all succeed
```

**Benefit**: Cursor advances only when entire batch completes

### Pattern 4: Reorg Recovery via Hash Validation

```typescript
if (prevLedger.hash !== ledgerMeta.previousLedgerHash) {
  throw new Error("Reorg detected")
  // Caller catches, retries after rollback
}
```

**Benefit**: Automatic detection without external monitoring

### Pattern 5: Dead-Letter Queue for Failures

```typescript
try {
  await processItem(...)
} catch (err) {
  await enqueueFailure(...)
}
// Later: retryFailures(handler)
```

**Benefit**: No loss of data; manual inspection for dead items

---

## 9. Performance Characteristics

### Throughput
- **Ledger Processing**: ~100-1000 ledgers/batch (configurable)
- **Parallel Workers**: 1-32 concurrent (configurable)
- **Event Fetching**: 200 events/page, paginated
- **RPC Retry**: 6 attempts with exponential backoff (up to 16s)

### Latency
- **WebSocket**: Sub-100ms for real-time ledger notifications
- **Polling Fallback**: 5s default interval
- **Batch Processing**: Depends on ledger size; typically 1-10s per batch
- **Database Writes**: Milliseconds per upsert (with indexes)

### Storage
- **IndexerState**: O(1) - single row
- **LedgerGap**: O(gaps) - typically 0-10 rows
- **ReorgEvent**: O(reorgs) - rare, typically 0 rows
- **FailedItem**: O(failures) - depends on stability; max 3 retries/item

---

## 10. Deployment Considerations

### Environment Variables

**Indexer**:
```bash
INDEXER_START_LEDGER=0                    # Resume from checkpoint
INDEXER_POLL_INTERVAL_MS=5000
INDEXER_BATCH_SIZE=100
INDEXER_CATCHUP_WORKERS=4
DISABLE_INDEXER=false                     # Disable indexer entirely
```

**Optional Services**:
```bash
ENABLE_POOL_MONITOR=false
ENABLE_ARBITRAGE_SCANNER=false
ENABLE_FEE_AGGREGATOR=false
ENABLE_PRIVACY_WS=false
ENABLE_COMPOSABILITY_WS=false
ENABLE_ARBITRAGE_WS=false
```

**Network**:
```bash
STELLAR_NETWORK=testnet                   # devnet | testnet | mainnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org  # Network RPC
STELLAR_RPC_WS_URL=wss://...              # WebSocket RPC
```

**Database**:
```bash
DATABASE_URL=postgresql://...
READ_REPLICA_URL=postgresql://...         # Optional, for scaling reads
```

**Cache**:
```bash
CACHE_URL=redis://localhost:6379          # Optional Redis
```

### High-Availability Setup

1. **Read Replicas**: Use `READ_REPLICA_URL` for non-critical queries
2. **Load Balancing**: Run multiple indexer instances (each fetches latest independently)
3. **Database Backup**: Snapshot before resuming from checkpoint
4. **Monitoring**: Export `/metrics` to Prometheus; alert on `indexer_ingestion_lag_ledgers` > threshold

### Scaling Recommendations

| Component | Strategy | Notes |
|-----------|----------|-------|
| **Single Ledger** | Increase `INDEXER_CATCHUP_WORKERS` | More parallel processing |
| **Catch-up** | Increase `INDEXER_BATCH_SIZE` | Larger batches (up to 1000) |
| **Real-time Response** | Lower `INDEXER_POLL_INTERVAL_MS` | More frequent polling |
| **Storage** | Archive old Ledger/Event/Transaction rows | Implement data retention policy |
| **WebSocket Load** | Add more `/ws/events` servers | Use reverse proxy load balancing |

---

## Summary

The indexer is production-ready with:
- ✅ Real-time ledger processing via WebSocket + polling fallback
- ✅ Automatic reorg detection and recovery
- ✅ Parallel batch processing for catch-up
- ✅ Dead-letter queue for robust error handling
- ✅ Comprehensive metrics and health checks
- ✅ Multi-channel pub/sub for real-time consumers
- ✅ Graceful shutdown with state persistence
- ✅ Optional scalable services (arbitrage, pool monitoring, etc.)

Its architecture is designed for high throughput, low latency, and resilience to network and database failures.
