# Request Timeout Middleware — Design & Operation

## Overview

The request timeout middleware prevents long-running requests (archive queries, analytics operations, data exports) from hanging indefinitely. It enforces configurable timeouts per route group and forcibly terminates requests that exceed their allocated time by destroying the socket.

### Problem Solved

Without timeout enforcement:
- Archive queries, analytics, or bulk exports could hang indefinitely
- Database connection leaks accumulate as clients never disconnect
- Load balancers would eventually exhaust worker pools
- Clients would hang with no feedback, forced to implement their own timeouts

### Solution

- **Early timeout detection** — timer fires before request completes
- **Socket destruction** — forces immediate client disconnect
- **Route-based grouping** — different timeout tiers for different endpoint types
- **Configurable per tier** — tune each category independently via environment variables
- **Minimal overhead** — simple middleware, no external dependencies

---

## Timeout Tiers

Routes are automatically grouped into four timeout categories:

| Tier | Timeout | Routes | Use Case |
|------|---------|--------|----------|
| **Fast** | 5s | `/health`, `/livez`, `/readyz`, `/metrics`, `/p2p/status` | Lightweight health checks & probes |
| **Normal** | 30s | `/api/v1/transactions`, `/api/v1/events`, `/api/v1/contracts`, `/api/v1/wallets/*`, `/api/v1/tokens`, `/api/graphql`, `/api/billing` | Standard API queries with moderate result sets |
| **Long** | 5 min | `/api/v1/analytics/*`, `/api/v1/archive/*`, `/api/v1/export/*`, `/p2p/ledger/*` | Analytics, archival queries, expensive computation |
| **Extended** | 15 min | `/api/v1/bulk/*` | Bulk operations, large data transfers |

### Default Timeouts (in milliseconds)

```env
TIMEOUT_FAST_MS=5000
TIMEOUT_NORMAL_MS=30000
TIMEOUT_LONG_MS=300000        # 5 min = 300,000 ms
TIMEOUT_EXTENDED_MS=900000    # 15 min = 900,000 ms
```

All are configurable via environment variables (see **Configuration** below).

---

## Behavior on Timeout

When a request exceeds its timeout:

1. A warning is logged with request details (method, path, timeout label, client IP)
2. A 408 Request Timeout response is immediately sent
3. The socket is forcibly destroyed to close the connection
4. Client receives the 408 with a JSON error body:

```json
{
  "error": "Request Timeout",
  "message": "Request exceeded 30000ms timeout limit for transactions-api",
  "code": "REQUEST_TIMEOUT"
}
```

The socket destruction ensures the connection doesn't linger (important for clients that ignore the 408 status).

---

## Configuration

### Environment Variables

Add these to your `.env` file (values are in milliseconds):

```env
# Health checks — should be near-instant
TIMEOUT_FAST_MS=5000

# Standard API queries — allow moderate processing time
TIMEOUT_NORMAL_MS=30000

# Analytics, exports, archive queries — longer operations
TIMEOUT_LONG_MS=300000

# Bulk operations — allow ample time
TIMEOUT_EXTENDED_MS=900000
```

### Customizing Timeouts at Runtime

For testing or advanced scenarios, you can programmatically set custom timeouts before mounting the middleware:

```typescript
import { setCustomTimeout, requestTimeout } from './middleware/requestTimeout';

// Add a custom route with a 2-minute timeout
setCustomTimeout(/^\/api\/v1\/custom-endpoint/, 120_000, 'custom-endpoint');

app.use(requestTimeout());
```

Custom routes are checked first, so they take precedence over built-in patterns.

---

## Route Mapping

### Fast (5s)

- `/health` — overall service health
- `/livez` — liveness probe (is the process alive?)
- `/readyz` — readiness probe (can the service handle traffic?)
- `/ready` — legacy readiness endpoint
- `/metrics` — Prometheus metrics export
- `/p2p/status` — P2P node network status snapshot

### Normal (30s)

| Endpoint | Description |
|----------|-------------|
| `/api/v1/transactions` | List & filter transactions |
| `/api/v1/transactions/:hash` | Transaction detail + events |
| `/api/v1/events` | List & filter events |
| `/api/v1/events/:id` | Event detail |
| `/api/v1/contracts` | List contracts, contract detail, register ABI |
| `/api/v1/wallets/:addr/transactions` | Wallet transaction history |
| `/api/v1/wallets/:addr/events` | Wallet event history |
| `/api/v1/tokens` | Token list, detail, transfer history |
| `/api/graphql` | GraphQL queries |
| `/api/billing` | Billing-related endpoints |

### Long (5 min)

| Endpoint | Description |
|----------|-------------|
| `/api/v1/analytics/*` | Analytics queries, dashboards, templates, cost estimates |
| `/api/v1/archive/*` | Archive/cold storage queries |
| `/api/v1/export/*` | Data export operations |
| `/p2p/ledger/*` | P2P ledger resolution (may trigger on-the-fly indexing) |

### Extended (15 min)

| Endpoint | Description |
|----------|-------------|
| `/api/v1/bulk/*` | Bulk operations (e.g., mass contract registration) |

---

## Logging

Timeout events are logged at `WARN` level with structured data:

```
[timeout] Request exceeded limit
method=GET
path=/api/v1/analytics/query
label=analytics-query
timeoutMs=300000
remoteAddr=192.168.1.100
```

Monitor your logs for timeout patterns:

```bash
# Count timeouts by endpoint
grep '\[timeout\]' /var/log/app.log | jq '.label' | sort | uniq -c

# Find clients frequently timing out
grep '\[timeout\]' /var/log/app.log | jq '.remoteAddr' | sort | uniq -c
```

---

## Performance Considerations

### Overhead

- **Per-request**: Single timer setup + one cleanup on finish/close (microseconds)
- **Memory**: One timeout handle per active request (~48 bytes per request)
- **CPU**: No polling — timers fire at scheduled time

### Socket Destruction Safety

Calling `socket.destroy()` is safe when:
- Response headers haven't been sent (checked via `res.headersSent`)
- The timeout has legitimately fired (not a spurious timeout)

The middleware ensures a 408 response is sent before destruction, so clients receive both status and error details.

### Connection Pool Impact

Timeout enforcement improves pool utilization:
- Hanging requests are cleared out, freeing worker threads
- Database connections are released faster
- Load balancer isn't starved by hung requests

---

## Troubleshooting

### "Request Timeout" errors for legitimate long-running queries

**Symptom**: Clients receive 408 errors for queries that genuinely take a long time (e.g., a complex analytics query that takes 45 seconds).

**Solution**:
1. Identify the endpoint path
2. Check which timeout tier it's in
3. Increase the timeout for that tier:
   ```env
   # If the endpoint is in LONG tier but your query needs 10 min:
   TIMEOUT_LONG_MS=600000  # 10 min instead of 5 min
   ```
4. Consider optimizing the query itself (indexing, pagination, query rewrite)

### WebSocket upgrade requests timing out

**Symptom**: WebSocket connections are closed before upgrade completes.

**Solution**: WebSocket upgrades should not go through the HTTP timeout middleware. Verify that:
- The middleware is not applied to upgrade handlers
- Upgrade handlers are on a separate route group (e.g., `/api/v1/ws`)
- The WebSocket gets the extended timeout (15 min by default)

If issues persist, you can skip the middleware for specific routes:

```typescript
app.use((req, res, next) => {
  // Skip timeout for WebSocket upgrades
  if (req.headers.upgrade === 'websocket') {
    return next();
  }
  requestTimeout()(req, res, next);
});
```

### Timeouts fire inconsistently (some requests timeout, others don't)

**Symptom**: Random 408 errors even though queries are similar.

**Possible causes**:
1. **Database load** — query time varies due to lock contention or disk I/O
2. **Cache misses** — cold cache causes first query to take longer
3. **Network jitter** — slow network to RPC increases processing time

**Solution**:
1. Monitor query execution time:
   ```sql
   SELECT path, AVG(duration_ms), MAX(duration_ms) 
   FROM request_logs 
   GROUP BY path 
   ORDER BY MAX(duration_ms) DESC;
   ```
2. Set timeout to `max(duration) * 1.5` to allow for variability
3. Add query caching or pagination to reduce individual request size

---

## Advanced: Custom Middleware Integration

### Using with Express Router

The middleware can be applied at the app level (global) or per-router:

```typescript
// Global (applies to all routes)
app.use(requestTimeout());

// Or per-router (only that router's routes)
const router = express.Router();
router.use(requestTimeout());
router.get('/expensive', handler);
```

### Disabling Timeout for Specific Routes

Create a wrapper that skips timeout for specific paths:

```typescript
app.use((req, res, next) => {
  // Skip timeout for internal health checks
  if (req.path === '/internal/debug') {
    return next();
  }
  requestTimeout()(req, res, next);
});
```

### Exporting Timeout Configuration

Get the current timeout configuration for dashboards or monitoring:

```typescript
import { getTimeoutConfig } from './middleware/requestTimeout';

const config = getTimeoutConfig();
console.log(config);
// Output:
// {
//   'health-check': 5000,
//   'transactions-api': 30000,
//   'analytics-query': 300000,
//   ...
// }
```

---

## Testing

### Unit Test Example

```typescript
import request from 'supertest';
import app from '../index';

describe('Request Timeout Middleware', () => {
  it('should timeout slow endpoints', async () => {
    jest.setTimeout(10000);
    
    // Mock a slow handler
    app.get('/slow', (req, res) => {
      setTimeout(() => res.json({ ok: true }), 60000);
    });
    
    // Set a short timeout for testing
    process.env.TIMEOUT_NORMAL_MS = '1000';
    
    const res = await request(app).get('/slow');
    expect(res.status).toBe(408);
    expect(res.body.code).toBe('REQUEST_TIMEOUT');
  });
});
```

### Integration Test: Load Testing

Use `k6` or `Apache JMeter` to verify timeout behavior under load:

```javascript
// k6 script
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const res = http.get('http://localhost:3000/api/v1/analytics/query?slow=true');
  check(res, {
    'status 408 on timeout': (r) => r.status === 408,
    'error code present': (r) => r.body.includes('REQUEST_TIMEOUT'),
  });
}
```

---

## Related Issues & References

- **Issue #546**: "No request timeout configured. Long-running requests could hang indefinitely."
- **Issue #566**: Analytics Data Lake — long-running Athena queries need timeout protection
- **Express timeout patterns**: https://expressjs.com/en/guide/error-handling.html
- **Node.js socket destruction**: https://nodejs.org/api/net.html#net_socket_destroy

---

## Maintenance

### Monitoring Timeout Health

Add a dashboard metric:

```typescript
import { register, Gauge } from 'prom-client';

const timeoutCounter = new Gauge({
  name: 'requests_timeout_total',
  help: 'Total requests that hit timeout limit',
  labelNames: ['route_label'],
  registers: [register],
});
```

Log to your monitoring system:

```
[timeout] Request exceeded limit
method=GET
path=/api/v1/analytics/query
label=analytics-query
timeoutMs=300000
```

### Adjusting Timeouts Over Time

As your data and traffic grow, re-evaluate timeouts:

1. **Collect baseline metrics** — run requests and measure P50, P95, P99 latency
2. **Set timeout = P99 * 1.5** to allow for natural variance
3. **Monitor timeout frequency** — if > 0.1% of requests timeout, increase
4. **Re-baseline quarterly** — as data volume changes

---

## FAQ

**Q: What if my proxy/load balancer also has timeouts?**  
A: Set the application timeout slightly lower than the proxy timeout. This gives the app a chance to send a 408 before the proxy closes the connection.

**Q: Can I set different timeouts per API key/tier?**  
A: Currently, timeouts are global by route pattern. For per-key timeouts, apply custom middleware:
```typescript
if (req.apiTier === 'premium') {
  timeout = TIMEOUT_EXTENDED_MS;
}
```

**Q: Does timeout respect in-flight transactions?**  
A: Yes. The timeout fires after the given interval regardless of what's happening. If a database transaction is mid-commit, the socket destruction will force rollback. This is intentional — hung transactions are dangerous.

**Q: What if I need to increase one timeout without restarting?**  
A: Use feature flags or a config server to update `TIMEOUT_LONG_MS` at runtime:
```typescript
app.get('/admin/config/timeout/:key/:value', (req, res) => {
  process.env[`TIMEOUT_${req.params.key}_MS`] = req.params.value;
  res.json({ updated: true });
});
```
