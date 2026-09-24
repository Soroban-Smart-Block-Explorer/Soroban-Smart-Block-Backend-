# Response Compression Middleware

## Overview

Automatic response compression using gzip or brotli for large API responses. Uses Node.js built-in `zlib` module—no external dependencies required.

## Benefits

- **Bandwidth Savings:** 60-85% size reduction for JSON payloads
- **List Endpoints:** 10MB response → ~1.5MB (gzip) or ~500KB (brotli)
- **Smart Threshold:** Only compresses responses >= 1KB to avoid overhead
- **Automatic Negotiation:** Respects `Accept-Encoding` header from clients
- **Zero Configuration:** Works out-of-the-box with sensible defaults
- **Graceful Degradation:** Falls back to uncompressed if compression fails
- **No External Dependencies:** Uses Node.js zlib

## How It Works

```
Client Request
  ↓
Check Accept-Encoding header
  ↓
Select: brotli > gzip > identity (uncompressed)
  ↓
Response generated (res.json or res.end)
  ↓
If size >= threshold (1KB):
  Apply compression → Set Content-Encoding header
Else:
  Send uncompressed (no overhead for small responses)
  ↓
Client decompresses automatically
```

## Configuration

```typescript
compressionMiddleware({
  threshold: 1024,      // Min size to compress (bytes). Default: 1KB
  gzipLevel: 6,         // Gzip compression 0-9. Default: 6 (balanced)
  brotliLevel: 6,       // Brotli compression 0-11. Default: 6 (balanced)
  enableBrotli: true,   // Try brotli first. Default: true
  filter: (type) => {}, // Custom content-type filter
  logStats: false,      // Log compression stats. Default: false
})
```

## Compression Levels

**Gzip (0-9):**
- 0: No compression (fastest)
- 1: Fast
- 6: Default (balanced)
- 9: Best compression (slowest)

**Brotli (0-11):**
- 0: Fastest
- 6: Default (balanced)
- 11: Best compression (slowest)

**Recommendation:** Use level 6 for production. CPU cost minimal, bandwidth savings significant.

## Real-World Impact

### Example: Contract List Endpoint
```
Uncompressed:
- 100 contracts × 50KB per contract = 5MB response
- Bandwidth: 5MB

With gzip (level 6):
- Compression ratio: ~75%
- Size: 1.25MB
- Bandwidth saved: 3.75MB (75%)
- Time @ 10Mbps: 1 second → 0.25 seconds

With brotli (level 6):
- Compression ratio: ~80%
- Size: 1MB
- Bandwidth saved: 4MB (80%)
- Time @ 10Mbps: 1 second → 0.2 seconds
```

## Automatic Header Handling

The middleware automatically:

1. **Reads** `Accept-Encoding` request header
2. **Selects** best available algorithm (brotli > gzip)
3. **Compresses** response if applicable
4. **Sets** `Content-Encoding` response header
5. **Updates** `Content-Length` with compressed size

Clients automatically decompress based on `Content-Encoding` header.

## Performance

| Response Size | Threshold Hit | Compression | Result |
|---------------|--------------|------------|--------|
| 500 bytes     | No           | No         | Sent as-is (no overhead) |
| 5 KB          | Yes          | gzip       | ~1.5 KB (~70% savings) |
| 100 KB        | Yes          | brotli     | ~15 KB (~85% savings) |
| 1 MB          | Yes          | brotli     | ~150 KB (~85% savings) |

## Supported Content Types

By default, compresses:
- `application/json` - API responses
- `text/plain` - Text responses
- `text/html` - HTML pages
- `application/javascript` - JavaScript files

## Error Handling

If compression fails:
- Logs warning
- Falls back to uncompressed response
- Continues normally

No impact to availability or correctness.

## Client Support

### Modern Browsers
All support both gzip and brotli automatically.

### JavaScript Fetch API
```javascript
// Automatic decompression (browser handles it)
const response = await fetch('/api/items');
const data = await response.json();
```

### curl
```bash
# Explicitly enable compression
curl -H "Accept-Encoding: gzip, deflate" http://localhost:3000/api/items

# See compression details
curl -i -H "Accept-Encoding: gzip" http://localhost:3000/api/items | head
# Shows: Content-Encoding: gzip
```

### Node.js
```typescript
import { createGunzip } from 'zlib';
import { pipeline } from 'stream';

const response = await fetch('/api/items');
const decompressed = await pipeline(
  response.body,
  createGunzip(),
  (err) => { if (err) throw err; }
);
```

## Monitoring

### Get Compression Stats
```typescript
import { getCompressionStats } from './middleware/compression';

app.use((req, res, next) => {
  res.on('finish', () => {
    const stats = getCompressionStats(req);
    console.log(`Compression: ${stats.encoding} (${stats.originalSize} → ${stats.compressedSize} bytes)`);
  });
  next();
});
```

### Log Compression Stats
```typescript
compressionMiddleware({
  logStats: true, // Enable in any environment
})
```

Development logs:
```
DEBUG Response compressed with gzip { original: 50000, compressed: 12345, ratio: '75.3%' }
DEBUG Response compressed with brotli { original: 50000, compressed: 9876, ratio: '80.2%' }
```

## Best Practices

✅ **Do:**
- Enable brotli for best compression
- Use level 6 for balanced speed/compression
- Keep threshold at 1KB for optimal cost/benefit
- Monitor compression stats in production
- Test with real client Accept-Encoding headers

❌ **Don't:**
- Use level 11 (brotli) in production—too slow
- Set threshold too low (overhead on small responses)
- Compress already-compressed data (images, videos)
- Forget to test with clients that don't support compression

## Integration

The middleware is registered in `src/index.ts` after `correlationMiddleware`:

```typescript
app.use(correlationMiddleware);
app.use(responseEnvelopeMiddleware);
app.use(compressionMiddleware({
  threshold: 1024,
  gzipLevel: 6,
  brotliLevel: 6,
  enableBrotli: true,
  logStats: config.nodeEnv === 'development',
}));
```

Applies to all routes after this point.

## Files

- **Implementation:** `src/middleware/compression.ts` (233 lines)
- **Registration:** `src/index.ts`
- **Tests:** `tests/compression.test.ts`
- **Documentation:** This file

## See Also

- Response Envelope: `src/middleware/responseEnvelope.ts`
- Correlation Middleware: `src/middleware/correlation.ts`
- Node.js zlib: https://nodejs.org/api/zlib.html
