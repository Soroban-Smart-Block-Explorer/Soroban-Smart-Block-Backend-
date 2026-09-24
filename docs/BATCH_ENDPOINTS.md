# Batch API Endpoints

Batch endpoints allow power users to fetch multiple items in a single API request, significantly reducing latency and improving throughput for bulk operations.

## Overview

Instead of making individual requests for each item:
```
GET /api/v1/transactions/hash1
GET /api/v1/transactions/hash2
GET /api/v1/transactions/hash3
```

Fetch all items in one request:
```
POST /api/v1/batch/transactions
```

### Benefits

- **Reduced latency**: Single request instead of N requests (saves network round-trips)
- **Improved throughput**: Send 100 items per request (vs 1 item per request)
- **Lower rate limit impact**: Batch requests count as single call (under development)
- **Predictable ordering**: Response maintains input order for easy mapping

## Endpoints

### 1. Batch Events

**POST** `/api/v1/batch/events`

Fetch multiple events by ID in a single request.

#### Request

```json
{
  "ids": [
    "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg==",
    "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw"
  ]
}
```

#### Response

```json
{
  "data": [
    {
      "id": "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg==",
      "transactionHash": "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566",
      "contractAddress": "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5",
      "eventType": "transfer",
      "topicSymbol": "transfer",
      "decoded": {
        "from": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        "to": "GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT",
        "amount": "1000000000"
      },
      "ledgerSequence": 3168075,
      "ledgerCloseTime": "2026-06-19T07:24:26.000Z"
    },
    null
  ],
  "missing": [
    "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw"
  ]
}
```

#### Parameters

- `ids` (array, required) — Array of event IDs to fetch (1-100 items)

#### Limits

- **Min items**: 1
- **Max items**: 100

#### Behavior

- Returns items in the same order as input
- Missing items are represented as `null` in the `data` array
- `missing` array lists all IDs that were not found

---

### 2. Batch Transactions

**POST** `/api/v1/batch/transactions`

Fetch multiple transactions by hash in a single request.

#### Request

```json
{
  "hashes": [
    "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566",
    "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"
  ]
}
```

#### Response

```json
{
  "data": [
    {
      "hash": "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566",
      "ledgerSequence": 3168075,
      "ledgerCloseTime": "2026-06-19T07:24:26.000Z",
      "sourceAccount": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "contractAddress": "CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5",
      "functionName": "swap",
      "functionArgs": {
        "amount_in": "1000000000",
        "amount_out": "987000000"
      },
      "status": "success",
      "humanReadable": "GBZX...swapped 100 USDC for 98.7 XLM on StellarSwap",
      "feeCharged": 100000,
      "sorobanResources": {
        "cpuInstructions": 2000000,
        "memoryBytes": 1024000
      },
      "failureReason": null,
      "events": [
        {
          "id": "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg==",
          "eventType": "transfer",
          "topicSymbol": "transfer",
          "decoded": { "from": "...", "to": "...", "amount": "..." }
        }
      ]
    },
    null
  ],
  "missing": [
    "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"
  ]
}
```

#### Parameters

- `hashes` (array, required) — Array of transaction hashes to fetch (1-100 items)

#### Limits

- **Min items**: 1
- **Max items**: 100

#### Behavior

- Returns full transaction details including related events
- Items appear in the same order as input
- Missing items are represented as `null`
- `missing` array lists all hashes that were not found

---

### 3. Batch Accounts

**POST** `/api/v1/batch/accounts`

Fetch activity summaries for multiple Stellar accounts.

#### Request

```json
{
  "addresses": [
    "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    "GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT"
  ]
}
```

#### Response

```json
{
  "data": [
    {
      "address": "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "transactionCount": 42,
      "eventCount": 127,
      "firstActivityLedger": 3167000,
      "lastActivityLedger": 3168075,
      "firstActivityTime": "2026-06-18T12:00:00.000Z",
      "lastActivityTime": "2026-06-19T07:24:26.000Z"
    },
    null
  ],
  "inactive": [
    "GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT"
  ]
}
```

#### Parameters

- `addresses` (array, required) — Array of Stellar account addresses to fetch (1-100 items)

#### Limits

- **Min items**: 1
- **Max items**: 100

#### Behavior

- Returns account activity statistics
- Inactive accounts (no Soroban activity) are `null` in `data` array
- `inactive` array lists all addresses with no activity
- Items appear in the same order as input

---

## Usage Examples

### JavaScript/TypeScript

```typescript
import axios from 'axios';

const client = axios.create({
  baseURL: 'https://api.soroban-explorer.io/api/v1',
  headers: process.env.API_KEY ? { 'X-API-Key': process.env.API_KEY } : {},
});

// Fetch 50 transactions in one request
async function getMultipleTransactions(hashes: string[]) {
  const response = await client.post('/batch/transactions', { hashes });
  return response.data;
}

// Usage
const result = await getMultipleTransactions([
  'hash1',
  'hash2',
  // ... up to 100
]);

// Filter out missing items
const transactions = result.data.filter((tx: any) => tx !== null);
console.log(`Found ${transactions.length} of ${result.data.length} transactions`);
console.log(`Missing: ${result.missing.join(', ')}`);
```

### Python

```python
import requests

API_BASE = 'https://api.soroban-explorer.io/api/v1'
headers = {'X-API-Key': os.getenv('API_KEY')} if os.getenv('API_KEY') else {}

# Batch fetch events
event_ids = ['event1', 'event2', 'event3']
response = requests.post(
    f'{API_BASE}/batch/events',
    json={'ids': event_ids},
    headers=headers
)

result = response.json()

# Process results
for i, event_id in enumerate(event_ids):
    if result['data'][i] is not None:
        print(f'Event {event_id}: {result["data"][i]}')
    else:
        print(f'Event {event_id}: Not found')

print(f'Missing: {result["missing"]}')
```

### curl

```bash
# Batch fetch transactions
curl -X POST https://api.soroban-explorer.io/api/v1/batch/transactions \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-api-key' \
  -d '{
    "hashes": [
      "3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566",
      "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"
    ]
  }'

# Batch fetch account summaries
curl -X POST https://api.soroban-explorer.io/api/v1/batch/accounts \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-api-key' \
  -d '{
    "addresses": [
      "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
      "GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT"
    ]
  }'
```

---

## Performance

### Typical Response Times

| Endpoint | 10 items | 50 items | 100 items |
|----------|----------|----------|-----------|
| `/batch/events` | ~50ms | ~200ms | ~400ms |
| `/batch/transactions` | ~80ms | ~350ms | ~700ms |
| `/batch/accounts` | ~100ms | ~400ms | ~800ms |

*Times are approximate and depend on database load and network latency.*

### Network Efficiency

Fetching 100 items:
- **Individual requests**: 100 HTTP requests + 100 TCP connections + 100 TLS handshakes
- **Batch request**: 1 HTTP request + 1 TCP connection + 1 TLS handshake

Savings:
- Network round-trips: 99 fewer
- Bandwidth overhead: ~99kb savings (HTTP headers, TCP/IP overhead)
- Latency: ~50-500ms faster (depending on network conditions)

---

## Error Handling

### Validation Errors

```json
{
  "error": "ids array must contain at least 1 item(s)"
}
```

**Status**: 400

Caused by:
- Empty array
- More than 100 items
- Missing required field

### Partial Results

When some items are found and others are not:
- **Status**: 200 (still successful)
- **Response**: `data` contains mix of objects and `null` values
- **Missing**: Lists IDs/hashes/addresses that were not found

Example:
```json
{
  "data": [
    { "id": "found-1", ... },
    null,
    { "id": "found-2", ... }
  ],
  "missing": ["not-found"]
}
```

---

## Rate Limiting

Batch requests currently count as **single requests** against your rate limit, regardless of how many items you fetch. A request with 100 items costs 1 rate limit token.

**Note**: Future versions may implement separate rate limiting for batch operations.

---

## Ordering Guarantee

All batch endpoints guarantee that results are returned in the **exact same order as the input**.

This allows for easy correlation:

```typescript
const result = await client.post('/batch/transactions', { hashes });

hashes.forEach((hash, index) => {
  const tx = result.data[index];
  console.log(`Hash: ${hash}`);
  console.log(`Status: ${tx ? 'found' : 'not found'}`);
});
```

---

## Migration Guide: Single → Batch

### Before (N requests)

```typescript
async function getTransactions(hashes: string[]) {
  const results = await Promise.all(
    hashes.map(hash => 
      fetch(`/api/v1/transactions/${hash}`).then(r => r.json())
    )
  );
  return results;
}
```

### After (1 request)

```typescript
async function getTransactions(hashes: string[]) {
  const result = await fetch('/api/v1/batch/transactions', {
    method: 'POST',
    body: JSON.stringify({ hashes })
  }).then(r => r.json());
  
  return result.data.filter(tx => tx !== null);
}
```

**Benefits**: 
- Faster (single round-trip instead of N)
- More reliable (no cascading failures)
- Uses less bandwidth
- Cleaner error handling

---

## Best Practices

### 1. Use Batch for Bulk Operations
✅ **Good**: Fetching 50-100 items from a list
❌ **Bad**: Single item lookup (use individual endpoint instead)

### 2. Handle Missing Items
Always check for `null` in the response:

```typescript
const validTransactions = result.data.filter(tx => tx !== null);
const missingCount = result.missing.length;

console.log(`Retrieved ${validTransactions.length}, missing ${missingCount}`);
```

### 3. Respect Rate Limits
Monitor `X-RateLimit-Remaining` even in batch requests:

```typescript
if (parseInt(response.headers['x-ratelimit-remaining']) < 10) {
  console.log('Approaching rate limit, pausing requests...');
  await sleep(60000);
}
```

### 4. Chunk Large Operations
For operations with more than 100 items, split into chunks:

```typescript
async function fetchAll(hashes: string[]) {
  const BATCH_SIZE = 100;
  const results = [];
  
  for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
    const chunk = hashes.slice(i, i + BATCH_SIZE);
    const response = await client.post('/batch/transactions', { hashes: chunk });
    results.push(...response.data);
  }
  
  return results;
}
```

### 5. Parallelize Batch Requests
Make multiple batch requests in parallel:

```typescript
const [eventBatch, txBatch, accountBatch] = await Promise.all([
  client.post('/batch/events', { ids: eventIds }),
  client.post('/batch/transactions', { hashes: txHashes }),
  client.post('/batch/accounts', { addresses })
]);
```

---

## FAQ

**Q: Can I make a batch request with duplicate IDs?**
A: Yes, duplicates are allowed. Each input position will be processed, even if the ID appears multiple times.

**Q: What's the maximum batch size?**
A: 100 items per request. For larger operations, split into multiple 100-item batches.

**Q: Are batch requests cheaper on my rate limit?**
A: Currently, a 100-item batch costs 1 rate limit token (same as any request). Future updates may offer different pricing for power users.

**Q: Can I mix different resource types in one batch request?**
A: No, batch endpoints are specialized by resource type (`/batch/events`, `/batch/transactions`, `/batch/accounts`).

**Q: What if some items are found and others aren't?**
A: The response has status 200 (success) with `null` values for missing items and a `missing` array listing what wasn't found.

**Q: Are results cached?**
A: Batch requests follow the same caching rules as individual endpoint requests (no special batch caching).

**Q: Can I sort the batch results?**
A: Results maintain input order. To sort, reorganize the array after receiving the response.
