# Soroban Data Mesh - Multi-Channel Real-Time Streaming Platform

A comprehensive data infrastructure platform providing real-time streaming, historical backfill, and market data analytics for Soroban blockchain data.

## Overview

The Data Mesh platform implements **Issue #311** with enterprise-grade real-time data streaming capabilities:

- ✅ **10 Real-time Channels** with <500ms latency
- ✅ **Multiple Delivery Methods** (WebSocket, SSE, Webhook, Queue)
- ✅ **Historical Backfill** in multiple formats (JSON, CSV, Parquet, Arrow)
- ✅ **Market Data API** with OHLC candlesticks and analytics
- ✅ **TypeScript SDK** for client integration
- ✅ **Normalized Data Schemas** with versioning
- ✅ **Subscription Management** with filtering and delivery stats

## Quick Start

### 1. Subscribe to Real-time Feed

```bash
curl -X POST http://localhost:3000/api/v1/feed/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "channelName": "trades",
    "filters": {
      "pools": ["CPOOL1...", "CPOOL2..."],
      "minAmount": "1000"
    },
    "deliveryType": "webhook",
    "deliveryConfig": {
      "url": "https://api.mysystem.com/soroban-feed",
      "headers": { "Authorization": "Bearer my-token" },
      "batchSize": 100,
      "retryOnFailure": true
    }
  }'
```

### 2. WebSocket Real-time Stream

```bash
# Connect to WebSocket
ws://localhost:3000/api/v1/feed/ws?channels=trades,events&filters={"pools":["CPOOL..."]}
```

### 3. Server-Sent Events

```bash
# HTTP streaming endpoint
curl http://localhost:3000/api/v1/feed/sse?channels=metrics&filters={}
```

### 4. Request Historical Data

```bash
curl -X POST http://localhost:3000/api/v1/feed/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "channelName": "trades",
    "startTime": "2025-01-01T00:00:00Z",
    "endTime": "2025-06-01T00:00:00Z",
    "format": "parquet",
    "filters": { "pools": ["CPOOL..."] }
  }'
```

## Available Channels

| Channel | Description | Latency Target |
|---------|-------------|----------------|
| `transactions` | Full decoded transactions with operations | <500ms |
| `events` | All contract events with decoded data | <200ms |
| `ledgers` | Ledger metadata (sequence, timestamp, tx count) | <100ms |
| `trades` | Normalized DEX swap trades | <500ms |
| `liquidations` | Liquidation events only | <200ms |
| `metrics` | Aggregated metrics (TPS, gas price, TVL) | <1s |
| `contracts` | New deployments and upgrades | <1s |
| `accounts` | Account activity (balance changes) | <500ms |
| `oracle` | Price oracle updates and deviations | <200ms |
| `governance` | Proposal creation, voting, execution | <1s |

## Data Schemas

### Transaction Schema
```json
{
  "type": "transaction",
  "schemaVersion": 1,
  "hash": "abc123...",
  "ledgerSequence": 12345,
  "timestamp": "2025-06-01T12:00:00Z",
  "sourceAccount": "G...",
  "operations": [...],
  "status": "success",
  "fee": "100"
}
```

### Trade Schema
```json
{
  "type": "trade",
  "schemaVersion": 1,
  "txHash": "abc123...",
  "poolAddress": "C...",
  "tokenIn": { "address": "C...", "symbol": "XLM" },
  "tokenOut": { "address": "C...", "symbol": "USDC" },
  "amountIn": "1000000000",
  "amountOut": "950000000",
  "price": "0.95",
  "timestamp": "2025-06-01T12:00:00Z"
}
```

## TypeScript SDK Usage

```typescript
import { SorobanFeed } from '@soroban/feed-sdk';

const feed = new SorobanFeed({ apiKey: 'my-key' });

// Subscribe to trades
const sub = await feed.subscribe({
  channelName: 'trades',
  filters: { pools: ['C...'] },
  deliveryType: 'webhook',
  deliveryConfig: {
    url: 'https://api.mysystem.com/soroban-feed'
  }
});

// WebSocket connection
const ws = feed.connectWebSocket(['trades'], { pools: ['C...'] });
ws.on('message', (trade) => console.log(trade));

// Server-Sent Events
const sse = feed.connectSSE(['events']);
sse.on('message', (event) => console.log(event));

// Backfill historical data
const backfill = await feed.backfill({
  channelName: 'trades',
  startTime: '2025-01-01T00:00:00Z',
  endTime: '2025-06-01T00:00:00Z',
  format: 'parquet'
});
```

## API Endpoints

### Feed Management
- `GET /api/v1/feed/channels` - List available channels
- `POST /api/v1/feed/subscribe` - Subscribe to feed
- `GET /api/v1/feed/subscriptions` - List subscriptions
- `GET /api/v1/feed/subscriptions/:id` - Get subscription details
- `PUT /api/v1/feed/subscriptions/:id` - Update subscription
- `DELETE /api/v1/feed/subscriptions/:id` - Unsubscribe

### Subscription Control
- `GET /api/v1/feed/subscriptions/:id/status` - Get delivery stats
- `POST /api/v1/feed/subscriptions/:id/pause` - Pause delivery
- `POST /api/v1/feed/subscriptions/:id/resume` - Resume delivery
- `POST /api/v1/feed/subscriptions/:id/test` - Send test payload

### Historical Data
- `POST /api/v1/feed/backfill` - Request historical data
- `GET /api/v1/feed/backfill/:requestId` - Check status & download
- `GET /api/v1/feed/backfill` - List backfill requests
- `GET /api/v1/feed/backfill/limits` - Get backfill limits

### Market Data
- `GET /api/v1/market/tokens` - All tracked tokens
- `GET /api/v1/market/tokens/:address` - Token market data
- `GET /api/v1/market/tokens/:address/price-history` - Price history
- `GET /api/v1/market/tokens/:address/ohlc` - OHLC candlesticks
- `GET /api/v1/market/overview` - Market overview

### Real-time Streaming
- `ws://api/v1/feed/ws` - WebSocket connection
- `GET /api/v1/feed/sse` - Server-Sent Events

## Filtering Options

```json
{
  "pools": ["CPOOL1...", "CPOOL2..."],
  "tokens": ["CTOKEN1...", "CTOKEN2..."],
  "minAmount": "1000",
  "excludePools": ["CBAD..."],
  "contracts": ["CCONTRACT..."],
  "accounts": ["GACCOUNT..."],
  "eventTypes": ["transfer", "swap", "mint"]
}
```

## Export Formats

- **JSONL** - Line-delimited JSON (BigQuery compatible)
- **CSV** - Comma-separated values with headers
- **Parquet** - Columnar storage (analytics optimized)
- **Arrow** - Apache Arrow IPC format
- **JSON** - Standard JSON array format

## Webhook Security

All webhook deliveries include HMAC-SHA256 signatures:

```javascript
const crypto = require('crypto');
const signature = req.headers['x-soroban-signature'];
const expectedSig = 'sha256=' + crypto
  .createHmac('sha256', webhookSecret)
  .update(JSON.stringify(req.body))
  .digest('hex');

if (signature === expectedSig) {
  // Payload is authentic
}
```

## Performance & Limits

- **Latency Targets**: <500ms for transactions/trades, <200ms for events
- **Throughput**: ≥1000 messages/second
- **Backfill Limits**: Max 90 days, 1GB files, 10M records
- **Rate Limits**: Configurable per subscription
- **Delivery Guarantees**: At-least-once with sequence tracking

## Architecture

The platform consists of:

1. **Feed Orchestrator** - Central message routing and distribution
2. **Channel Manager** - Schema validation and channel configuration  
3. **Subscription Manager** - Filter matching and delivery routing
4. **Delivery Service** - Multi-protocol message delivery
5. **WebSocket Server** - Real-time bidirectional streaming
6. **Backfill Engine** - Historical data export processing
7. **Market Data API** - Token analytics and OHLC data

## Integration with Indexer

The platform integrates seamlessly with the existing Soroban indexer:

- Transactions are published to the `transactions` channel when indexed
- Events are published to the `events` channel with decoded data
- Ledger close events trigger the `ledgers` channel
- Trade detection publishes to the `trades` channel
- System metrics are continuously published to the `metrics` channel

This creates a complete real-time data pipeline from Soroban blockchain events to client applications.
