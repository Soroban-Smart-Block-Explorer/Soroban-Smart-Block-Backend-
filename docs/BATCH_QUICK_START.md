# Batch API Quick Start

## TL;DR

Fetch up to 100 items in a single API request instead of making N individual requests.

### Three Batch Endpoints

```bash
# Fetch 100 events
curl -X POST https://api.example.com/api/v1/batch/events \
  -d '{"ids": ["id1", "id2", "...id100"]}'

# Fetch 100 transactions (includes related events)
curl -X POST https://api.example.com/api/v1/batch/transactions \
  -d '{"hashes": ["hash1", "hash2", "...hash100"]}'

# Fetch 100 account summaries
curl -X POST https://api.example.com/api/v1/batch/accounts \
  -d '{"addresses": ["GBZX...", "GCZS...", "..."]}'
```

## Quick Examples

### JavaScript

```typescript
import axios from 'axios';

const client = axios.create({
  baseURL: 'https://api.example.com/api/v1'
});

// Fetch 50 transactions in one request
const result = await client.post('/batch/transactions', {
  hashes: ['hash1', 'hash2', '...']
});

// Process results
result.data.data.forEach((tx, i) => {
  if (tx) {
    console.log(`${i}: ${tx.hash} - ${tx.status}`);
  } else {
    console.log(`${i}: NOT FOUND`);
  }
});
```

### Python

```python
import requests

api = 'https://api.example.com/api/v1'

# Fetch 30 events
response = requests.post(f'{api}/batch/events', json={
    'ids': ['id1', 'id2', '...']
})

result = response.json()
print(f"Found: {len([x for x in result['data'] if x])}")
print(f"Missing: {result['missing']}")
```

### Node.js (native fetch)

```javascript
const hashes = ['hash1', 'hash2', '...'];

const response = await fetch(
  'https://api.example.com/api/v1/batch/transactions',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes })
  }
);

const { data, missing } = await response.json();
console.log(`Got ${data.filter(x => x).length}, missing ${missing.length}`);
```

## Response Format

All batch endpoints return:

```json
{
  "data": [item1, null, item3, ...],
  "missing": ["id2", ...]
}
```

Key points:
- **data**: Results in same order as input (null for missing)
- **missing**: List of IDs/hashes/addresses not found
- Status: **200** (partial success) or **400** (validation error)

## Limits

| Limit | Value |
|-------|-------|
| Min items | 1 |
| Max items | 100 |
| Rate limit cost | 1 token (any size) |

## Common Patterns

### Filter out missing items

```typescript
const found = result.data.filter(item => item !== null);
```

### Map results by ID

```typescript
const resultMap = new Map(
  inputIds.map((id, i) => [id, result.data[i]])
);
```

### Check for partial failures

```typescript
if (result.missing.length > 0) {
  console.warn(`${result.missing.length} items not found`);
}
```

### Batch in chunks

```typescript
async function fetchAll(items, batchSize = 100) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const batch = await client.post('/batch/transactions', {
      hashes: chunk
    });
    results.push(...batch.data);
  }
  return results;
}
```

## Migration from Single Requests

### Before
```typescript
// Make 100 individual requests
const txs = await Promise.all(
  hashes.map(h => client.get(`/transactions/${h}`))
);
```

### After
```typescript
// Make 1 batch request
const result = await client.post('/batch/transactions', { hashes });
const txs = result.data.filter(tx => tx !== null);
```

**Result**: 5-10x faster, cleaner code

## Error Handling

```typescript
// Validation error (400)
try {
  await client.post('/batch/events', { ids: [] }); // Empty!
} catch (err) {
  if (err.response?.status === 400) {
    console.error(err.response.data.error);
    // "ids array must contain at least 1 item(s)"
  }
}

// Partial success (200)
const result = await client.post('/batch/transactions', { 
  hashes: ['found', 'not-found', 'found']
});
// result.data = [tx1, null, tx3]
// result.missing = ['not-found']
```

## Performance

| Operation | Time |
|-----------|------|
| 10 items | ~50-100ms |
| 50 items | ~200-400ms |
| 100 items | ~400-800ms |

**vs individual requests**: ~30ms × N items = 300-3000ms+ total

## Response includes

### `/batch/events`
- id, transactionHash, contractAddress, eventType, topicSymbol
- decoded (human-readable), ledgerSequence, ledgerCloseTime

### `/batch/transactions`
- hash, ledgerSequence, sourceAccount, contractAddress, functionName
- status, humanReadable, feeCharged, sorobanResources
- **events** (related events for this transaction)

### `/batch/accounts`
- address, transactionCount, eventCount
- firstActivityLedger, lastActivityLedger
- firstActivityTime, lastActivityTime

## Links

- **Full docs**: `docs/BATCH_ENDPOINTS.md`
- **Architecture**: `docs/BATCH_API_ARCHITECTURE.md`
- **Implementation**: `BATCH_API_IMPLEMENTATION.md`

## Support

Question? Check the FAQ in `docs/BATCH_ENDPOINTS.md` or review the error message (they're pretty clear).

---

**That's it!** You're now ready to use batch endpoints. Go fetch some data! 🚀
