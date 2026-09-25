# TypeScript SDK — Design (DX01)

Status: implemented · Package: `packages/client` (`@soroban-explorer/client` 1.1.0)

## Goals

One-line setup, 100 % REST parity, typed requests/responses, typed errors,
safe retries, realtime coverage, zero runtime dependencies, no breaking change
for 1.0 users.

## Architecture

```
src/indexer/swaggerSpec.ts ──► src/lib/openapi/normalize.ts ──► scripts/sdk/generate.ts
   (OpenAPI, source of truth)     (shared with try-it + Python)      │
                                                                     ├─ packages/client/src/generated/operations.ts
                                                                     │    OPERATIONS (runtime metadata)
                                                                     │    OperationTypes / OperationParams (types)
                                                                     ├─ packages/client/src/generated/models.ts
                                                                     ├─ packages/client/api-surface.json (semver gate)
                                                                     └─ docs/sdk/parity-matrix.md

packages/client/src/
  client.ts          SorobanClient: call(), paginate(), curated resources, realtime
  core/request.ts    param validation + path/query/body encoding from OPERATIONS
  core/http.ts       Transport: timeout, retries, Retry-After, rate-limit parse, telemetry hook
  core/errors.ts     error taxonomy
  feed.ts, reputation.ts   1.0 clients (unchanged)
```

### Data model

- `OPERATIONS[id]` → `{ method, path, pathParams, query[{name,type,required,enum,min,max}], body, contentType, deprecated, tags, summary }`.
- `OperationTypes[id]` → `{ path, query, body, response }` TypeScript types.
- `OperationParams[id]` → the precomputed argument shape for `call(id, params)`.
  Precomputed (instead of conditional types) because conditional mapping over
  494 operations exceeds the TypeScript compiler's union-complexity limit.
- Operation ids: the spec's `operationId` if present, otherwise derived from
  method + path (`GET /transactions/{hash}` → `getTransactionsByHash`),
  collision-suffixed deterministically.
- Unresolvable `$ref`s in the spec become `unknown` (never `any`).

## Behaviour under failure

| Condition                           | Behaviour                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| 429                                 | Retried (all methods) honouring `Retry-After` (capped), then `RateLimitError` |
| 502/503/504, network error, timeout | Retried for idempotent methods with exponential backoff + jitter              |
| POST/PATCH 5xx                      | Not retried (may have side effects) → `ServerError`                           |
| Invalid params                      | `RequestValidationError`, nothing sent                                        |
| Non-JSON error body                 | Message from body text, `body` preserved                                      |
| Telemetry hook throws               | Swallowed; request unaffected                                                 |
| Caller aborts (`signal`)            | Not retried; rejects                                                          |

## Security

- `baseUrl` must be http(s); URLs with embedded credentials are rejected; the
  API key travels only in `X-Api-Key`, never in URLs or logs (the SDK logs
  nothing unless given a logger, and never logs headers).
- Path params are percent-encoded; `.`/`..` rejected — a param cannot change
  the route.
- Unknown query params are rejected (typos don't silently widen queries).
- No runtime dependencies → no transitive supply-chain surface.

## Observability

The SDK is a library, so it exposes hooks rather than exporters:
`onRequest(event)` fires per attempt with operation id, status, duration,
attempt, retry decision, request id and rate-limit info — map it to
OpenTelemetry spans/metrics or Prometheus in the host app. Server-side SLOs
for SDK traffic are tracked via the `User-Agent: soroban-explorer-client-ts/*`
dimension in existing HTTP metrics.

## Rejected alternatives

- **openapi-generator / openapi-typescript** — new dependencies, heavier
  output, and they choke on this spec's dangling `$ref`s and Express-style
  `:param` paths; a 300-line in-repo emitter sharing the try-it normalizer is
  easier to audit.
- **Hand-written clients per route** — cannot keep parity with 494
  operations; drift was the status quo (1.0 docs referenced a nonexistent
  `SorobanClient`).
- **axios** — dependency; `fetch` is standard in Node ≥ 18 and browsers.

## Compatibility and migration

Additive minor release (1.0 → 1.1): all 1.0 exports unchanged. The code
examples served by `/api/v1/sdks/typescript/…/examples` (which referenced a
`SorobanClient` that did not exist) are now valid.

## Rollback

npm: `npm deprecate @soroban-explorer/client@1.1.0 "use 1.0.x"` and users pin
`1.0.x` (no API contract changed). Repository: revert the DX01 commit.
