# Try-it API Console — API Reference

All routes pass through the global middleware (auth, tier rate limit, CSP,
audit log). Rate-limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, `X-RateLimit-Tier`) are present on every response.

## `GET /api/try`

Console HTML. `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-cache`.

## `GET /api/try/app.js`

Console script. `Content-Type: application/javascript`, `ETag`,
`Cache-Control: public, max-age=300`. `If-None-Match` → `304`.

## `GET /api/try/catalog.json`

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "5b1f0c7e2a9d4e11"
Cache-Control: public, max-age=60
```

```json
{
  "title": "Soroban Smart Block Explorer API",
  "specVersion": "1.0.0",
  "basePath": "/api/v1",
  "operationCount": 494,
  "tags": ["Analytics", "Contracts", "Events", "Transactions", "…"],
  "etag": "5b1f0c7e2a9d4e11",
  "operations": [
    {
      "id": "getTransactionsByHash",
      "method": "GET",
      "path": "/transactions/{hash}",
      "summary": "Get a single transaction by hash",
      "description": "",
      "tags": ["Transactions"],
      "deprecated": false,
      "params": [
        {
          "name": "hash",
          "in": "path",
          "required": true,
          "type": "string",
          "description": "Transaction hash"
        }
      ],
      "body": null,
      "responses": [
        { "status": "200", "description": "The transaction, its decoded events, …" },
        { "status": "404", "description": "Not found" }
      ]
    },
    {
      "id": "postWebhooks",
      "method": "POST",
      "path": "/webhooks",
      "params": [],
      "body": {
        "required": true,
        "contentType": "application/json",
        "example": "{\n  \"url\": \"https://example.com/hook\"\n}"
      },
      "…": "…"
    }
  ]
}
```

`If-None-Match: <etag>` → `304 Not Modified`.

### Errors

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30

{"error":"API catalog temporarily unavailable","code":"TRYIT_CATALOG_UNAVAILABLE","fallback":"/api/v1/openapi.json"}
```

```http
HTTP/1.1 404 Not Found

{"error":"The API console is disabled","code":"FEATURE_DISABLED","fallback":"/api/v1/openapi.json"}
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Tier: public

{"error":"Too many requests", "…": "…"}
```

## Requests sent by the console

Every request is a normal `/api/v1` call with:

| Header         | Value                                                  |
| -------------- | ------------------------------------------------------ |
| `Accept`       | `application/json`                                     |
| `X-Client`     | `try-it` (attribution only)                            |
| `X-Api-Key`    | the key entered in the console, if any                 |
| `Content-Type` | the operation's body content type, when a body is sent |

## Share links

```
https://<host>/api/try#try=v1.eyJvIjoiZ2V0VHJhbnNhY3Rpb25zIiwicSI6eyJsaW1pdCI6IjUifX0
```

Decoded payload: `{"o":"getTransactions","q":{"limit":"5"}}`.

| Field | Type                     | Notes                                    |
| ----- | ------------------------ | ---------------------------------------- |
| `o`   | string                   | Operation id from the catalog. Required. |
| `p`   | `Record<string, string>` | Path parameters.                         |
| `q`   | `Record<string, string>` | Query parameters.                        |
| `b`   | string ≤ 64 KB           | Raw request body.                        |

Links are ≤ 8 KB, never contain credentials, and are versioned: `v1` links
will keep decoding in future versions.

## Versioning

Catalog fields are additive-only. Operation ids are derived deterministically
from method + path (or the spec's `operationId`), so a link keeps working as
long as the operation exists; removed operations produce
`Operation no longer exists: <id>`.
