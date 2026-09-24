# Rate Limit Headers

The API includes standard rate limit headers on all responses (including successful requests and 429 rate limit errors). These headers follow the [RFC 6585](https://tools.ietf.org/html/rfc6585) convention and enable clients to implement intelligent backoff strategies.

## Standard Headers

### X-RateLimit-Limit
Maximum number of requests allowed in the current window.

```
X-RateLimit-Limit: 100
```

### X-RateLimit-Remaining
Number of requests remaining in the current window. Decrements with each request and resets when the window expires.

```
X-RateLimit-Remaining: 87
```

### X-RateLimit-Reset
Unix timestamp (in seconds) when the current rate limit window expires. Use this to calculate exactly when to retry.

```
X-RateLimit-Reset: 1722282947
```

### X-RateLimit-Tier
The API tier applied to this request. Indicates which rate limit configuration was used.

```
X-RateLimit-Tier: free
```

Valid tiers: `free`, `developer`, `premium`, `enterprise`

### Retry-After (429 only)
Number of seconds to wait before retrying (only included in 429 responses). Clients should use this value or calculate from `X-RateLimit-Reset`.

```
Retry-After: 60
```

## Optional Headers

### X-RateLimit-Policy
Indicates a special policy applied to this request. Currently included when a user-specific rate limit override is in effect.

```
X-RateLimit-Policy: user-override
```

## Example Usage

### JavaScript/Node.js

```typescript
import axios from 'axios';

const client = axios.create({
  baseURL: 'https://api.example.com',
  headers: { 'X-API-Key': 'your-api-key' }
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 429) {
      const retryAfter = parseInt(
        error.response.headers['retry-after'] || 
        (Math.ceil(error.response.headers['x-ratelimit-reset'] - Date.now() / 1000))
      );
      
      console.log(`Rate limited. Retrying after ${retryAfter} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      
      return client.request(error.config);
    }
    return Promise.reject(error);
  }
);

// Make requests with backoff support
const response = await client.get('/api/v1/transactions');
console.log(`Requests remaining: ${response.headers['x-ratelimit-remaining']}`);
```

### Python

```python
import requests
import time

class RateLimitedSession(requests.Session):
    def request(self, *args, **kwargs):
        while True:
            response = super().request(*args, **kwargs)
            
            if response.status_code == 429:
                retry_after = int(
                    response.headers.get('Retry-After') or
                    (int(response.headers['X-RateLimit-Reset']) - time.time())
                )
                print(f"Rate limited. Retrying after {retry_after} seconds...")
                time.sleep(retry_after)
                continue
            
            # Log remaining requests
            remaining = response.headers.get('X-RateLimit-Remaining')
            if remaining:
                print(f"Requests remaining: {remaining}")
            
            return response

session = RateLimitedSession()
response = session.get(
    'https://api.example.com/api/v1/transactions',
    headers={'X-API-Key': 'your-api-key'}
)
```

### curl

```bash
# Make a request and inspect rate limit headers
curl -i -H 'X-API-Key: your-api-key' \
  https://api.example.com/api/v1/transactions

# Response will include:
# X-RateLimit-Limit: 250
# X-RateLimit-Remaining: 234
# X-RateLimit-Reset: 1722282947
# X-RateLimit-Tier: developer
```

## Rate Limit Tiers

| Tier | Requests per Minute | Use Case |
|------|-------------------|----------|
| free | 100 | Public/unauthenticated requests |
| developer | 250 | Development with an API key |
| premium | 1000 | Production applications |
| enterprise | custom | Custom SLA agreements |

## Best Practices

1. **Monitor `X-RateLimit-Remaining`**: Stop making new requests if this value is low.
2. **Pre-emptive backoff**: Implement exponential backoff before hitting the limit.
3. **Use Unix timestamps**: `X-RateLimit-Reset` is always a Unix timestamp in seconds for easy comparison with `Date.now() / 1000`.
4. **Respect Retry-After**: When receiving 429, always use the `Retry-After` header (or calculate from `X-RateLimit-Reset`).
5. **Per-tier strategies**: Premium tier requests can be made more aggressively than free tier.

## Example: Adaptive Request Rate

```typescript
async function makeRequestWithBackoff(
  client: AxiosInstance,
  endpoint: string,
  minRemaining: number = 10
) {
  const response = await client.get(endpoint);
  const remaining = parseInt(response.headers['x-ratelimit-remaining']);
  const resetAt = parseInt(response.headers['x-ratelimit-reset']);
  
  if (remaining < minRemaining) {
    const waitSeconds = resetAt - Math.floor(Date.now() / 1000);
    console.log(`Low requests remaining (${remaining}). Waiting ${waitSeconds}s until reset.`);
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
  }
  
  return response;
}
```
