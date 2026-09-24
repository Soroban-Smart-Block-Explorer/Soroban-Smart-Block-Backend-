# Enterprise Rate-Limit Tiers — Design, Operations & API Reference

> **Issue**: [#1027 \[PLT06\] Enterprise custom rate-limit tiers](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/1027)
> **Status**: Implemented — `feat/issue-1027-enterprise-custom-rate-limit-tiers`

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Architecture & Trade-offs](#architecture--trade-offs)
4. [Rejected Alternatives](#rejected-alternatives)
5. [Admin API Reference](#admin-api-reference)
6. [Operating Runbook](#operating-runbook)
7. [Header Reference](#header-reference)
8. [Feature-Flag Gating](#feature-flag-gating)
9. [Graceful Degradation](#graceful-degradation)

---

## Overview

Standard rate-limit tiers (free / developer / premium / enterprise) are defined globally in `src/auth/rbac.ts`. Enterprise customers with contractually negotiated higher limits require **per-organisation custom tiers** that can be managed without redeploying the service.

This feature adds:

| Component                         | Path                                                  |
| --------------------------------- | ----------------------------------------------------- |
| In-memory TTL cache               | `src/middleware/enterpriseTierCache.ts`               |
| Rate-limit enforcement middleware | `src/middleware/enterpriseRateLimit.ts`               |
| Admin CRUD API                    | `src/api/rate-limits.ts` (`/enterprise-tiers` routes) |
| Unit tests                        | `tests/enterpriseTier.test.ts`                        |

---

## Data Model

Enterprise tiers are stored in the **existing `RateLimitOverride` Prisma model** (table `_rate_limit_overrides`) to avoid a new migration. The mapping is:

| DB column    | Meaning for enterprise tiers                                     |
| ------------ | ---------------------------------------------------------------- |
| `identifier` | `ent:<orgId>` — e.g. `ent:org_acme`                              |
| `endpoint`   | JSON blob: `{ maxBurst, label, featureFlags, graceDegradation }` |
| `max`        | `maxPerMinute`                                                   |
| `windowMs`   | Rolling window in ms (default 60 000)                            |

### `EnterpriseTierConfig` shape

```typescript
interface EnterpriseTierConfig {
  maxPerMinute: number; // sustained req/min ceiling
  maxBurst: number; // token-bucket burst capacity
  windowMs: number; // rolling window (ms)
  label: string; // shown in X-RateLimit-Policy header
  featureFlags: string[]; // required flags for this tier
  graceDegradation: 'drop' | 'queue' | 'fallback';
}
```

### In-memory cache

`enterpriseTierCache.ts` maintains a `Map<orgId, { config, expiresAt }>` with a 5-minute TTL. Entries are lazily evicted on the next read after expiry. The admin API calls `clearEnterpriseTierCache(orgId)` on every mutating operation so the next request picks up the fresh value within milliseconds.

---

## Architecture & Trade-offs

### Why reuse `RateLimitOverride` instead of a new model?

**Pro**: Zero new migrations required. The table is already provisioned on all environments.  
**Con**: The `endpoint` column is repurposed as a JSON blob for enterprise metadata, which is semantically awkward. A future migration could add a dedicated `EnterpriseTierConfig` model and backfill the rows.

### Why an in-process Map rather than Redis for the cache?

**Pro**: No Redis dependency for cache reads — the enforcement path has zero network hops.  
**Con**: Each pod has its own cache. After an admin update, pods that have not yet had their cache TTL expire will continue applying the old config for up to 5 minutes. The `clearEnterpriseTierCache` call only affects the pod that handled the admin request.

**Mitigation**: The 5-minute TTL is short enough for most SLAs. For instant propagation, operators can issue a rolling restart or use the `DELETE` + `POST` endpoint in sequence to force a re-fetch.

### Why enforce in the middleware layer rather than in the token bucket?

The existing `checkTokenBucket` function (Redis Lua script) is not extended because:

1. Extending the Lua script would require coordinated Redis and application deploys.
2. The per-org bucket key space would grow unboundedly.
3. `applyEnterpriseRateLimit` sits in front of `tieredRateLimit` in the middleware chain, so enterprise requests are short-circuited before the generic limiter runs.

---

## Rejected Alternatives

| Alternative                             | Reason rejected                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| New `EnterpriseTierConfig` Prisma model | Requires a DB migration in all environments; deferred to a future cleanup issue.          |
| Redis-backed cache per org              | Adds Redis as a hard dependency for config reads; degrades cache availability.            |
| JWT-embedded org limits                 | Limits cannot be updated without re-issuing tokens; bad UX for enterprise renegotiations. |
| Per-endpoint custom limits              | Scope creep; endpoint-level overrides already handled by `RateLimitOverride`.             |

---

## Admin API Reference

All endpoints require the `X-Admin-Token` header (see `src/middleware/adminAuth.ts`).

### `GET /api/admin/rate-limits/enterprise-tiers`

List all custom enterprise tiers.

**Response 200**

```json
{
  "success": true,
  "tiers": [
    {
      "orgId": "org_acme",
      "maxPerMinute": 50000,
      "maxBurst": 5000,
      "windowMs": 60000,
      "label": "acme-enterprise-gold",
      "featureFlags": ["analytics", "bulk-export"],
      "graceDegradation": "fallback"
    }
  ]
}
```

---

### `POST /api/admin/rate-limits/enterprise-tiers`

Create or update the enterprise tier for an org.

**Request body**

```json
{
  "orgId": "org_acme",
  "maxPerMinute": 50000,
  "maxBurst": 5000,
  "windowMs": 60000,
  "label": "acme-enterprise-gold",
  "featureFlags": ["analytics", "bulk-export"],
  "graceDegradation": "fallback"
}
```

| Field              | Type     | Required | Default      | Constraints                           |
| ------------------ | -------- | -------- | ------------ | ------------------------------------- |
| `orgId`            | string   | ✅       | —            | 1–128 chars                           |
| `maxPerMinute`     | integer  | ✅       | —            | 1–10 000 000                          |
| `maxBurst`         | integer  | ✅       | —            | 1–10 000 000                          |
| `windowMs`         | integer  |          | 60 000       | 1–86 400 000                          |
| `label`            | string   | ✅       | —            | 1–128 chars                           |
| `featureFlags`     | string[] |          | `[]`         | each 1–64 chars                       |
| `graceDegradation` | enum     |          | `"fallback"` | `"drop"` \| `"queue"` \| `"fallback"` |

**Response 201**

```json
{
  "success": true,
  "orgId": "org_acme",
  "config": {
    "maxPerMinute": 50000,
    "maxBurst": 5000,
    "windowMs": 60000,
    "label": "acme-enterprise-gold",
    "featureFlags": ["analytics", "bulk-export"],
    "graceDegradation": "fallback"
  }
}
```

**Response 400** (validation failure)

```json
{
  "error": "Invalid enterprise tier payload",
  "details": { "fieldErrors": { "maxPerMinute": ["Number must be positive"] } }
}
```

---

### `GET /api/admin/rate-limits/enterprise-tiers/:orgId`

Retrieve the custom tier for a specific org.

**Response 200**

```json
{
  "success": true,
  "orgId": "org_acme",
  "config": { ... }
}
```

**Response 404** — no custom tier; standard enterprise defaults are returned for reference:

```json
{
  "error": "No custom enterprise tier found for this org",
  "orgId": "org_acme",
  "defaults": {
    "maxPerMinute": 10000,
    "maxBurst": 20000,
    "windowMs": 60000,
    "label": "enterprise",
    "featureFlags": [],
    "graceDegradation": "fallback"
  }
}
```

---

### `DELETE /api/admin/rate-limits/enterprise-tiers/:orgId`

Remove the custom tier for an org. The org reverts to standard enterprise defaults immediately (cache is cleared).

**Response 200**

```json
{
  "success": true,
  "orgId": "org_acme",
  "message": "Custom enterprise tier removed. Org will use standard enterprise defaults.",
  "defaults": { ... }
}
```

---

## Operating Runbook

### Setting a new enterprise tier for an org

```bash
curl -X POST https://api.example.com/api/admin/rate-limits/enterprise-tiers \
  -H "X-Admin-Token: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "org_acme",
    "maxPerMinute": 50000,
    "maxBurst": 5000,
    "label": "acme-gold",
    "featureFlags": [],
    "graceDegradation": "fallback"
  }'
```

The change is persisted to the DB and the in-memory cache is updated on the pod that served the request. Other pods will pick it up within the 5-minute cache TTL.

### Updating an existing tier

Re-POST with the same `orgId`. The endpoint is idempotent (upsert).

### Deleting / resetting to defaults

```bash
curl -X DELETE https://api.example.com/api/admin/rate-limits/enterprise-tiers/org_acme \
  -H "X-Admin-Token: $ADMIN_API_KEY"
```

### Debugging: which tier is active?

Inspect the response headers from any API call made by the org:

```
X-RateLimit-Tier:    enterprise-custom   ← custom config is active
X-RateLimit-Policy:  acme-gold           ← label from the config
X-RateLimit-Limit:   50000
X-RateLimit-Remaining: 49998
X-RateLimit-Reset:   1720000060
```

If `X-RateLimit-Tier` is `enterprise` (without `-custom`), the org is on standard defaults — either no custom config exists or the cache TTL expired and the DB returned no row.

### Recovering from stale cache

If a tier was updated but pods still serve the old config:

1. Wait up to 5 minutes for the TTL to expire naturally, **or**
2. Issue a rolling restart of the backend pods.

### DB health check

The admin API returns 500 if the DB is unreachable. The enforcement middleware (`applyEnterpriseRateLimit`) falls back to standard enterprise defaults and logs a warning — requests are never dropped due to a DB outage unless `graceDegradation: "drop"` is configured.

---

## Header Reference

| Header                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | Effective request ceiling for the current window.                           |
| `X-RateLimit-Remaining` | Requests remaining in the current window.                                   |
| `X-RateLimit-Reset`     | Unix timestamp (seconds) when the window resets.                            |
| `X-RateLimit-Tier`      | `enterprise-custom` for custom configs; `enterprise` for standard defaults. |
| `X-RateLimit-Policy`    | Human-readable label from `EnterpriseTierConfig.label`.                     |
| `Retry-After`           | Set only on 429 responses; seconds until the limit resets.                  |

---

## Feature-Flag Gating

When `featureFlags` is non-empty, the middleware checks the `X-Feature-Flags` request header (comma-separated). If any required flag is absent, the request is rejected with 403.

**Example tier config with flag gating:**

```json
{
  "orgId": "org_research",
  "maxPerMinute": 100000,
  "featureFlags": ["bulk-export", "raw-ledger-access"],
  ...
}
```

**Client must send:**

```
X-Feature-Flags: bulk-export,raw-ledger-access
```

This mechanism allows gating experimental high-throughput features to specific enterprise orgs without separate middleware.

---

## Graceful Degradation

When the cache lookup throws (e.g., DB connection timeout):

| Strategy               | Behaviour                                                                       |
| ---------------------- | ------------------------------------------------------------------------------- |
| `fallback` _(default)_ | Apply standard enterprise limits; log a warning. Request proceeds.              |
| `queue`                | Falls through to `fallback` at this layer (queue is a future concern).          |
| `drop`                 | Return 503 immediately. Use only for orgs where incorrect limits are dangerous. |

> [!CAUTION]
> Setting `graceDegradation: "drop"` means any infrastructure fault will cause 503s for that org. Reserve this for security-critical integrations only.

> [!NOTE]
> The `drop` path is only triggered when `usedFallback=true` AND the _registered_ config specifies `"drop"`. Because the fallback is triggered by a failed config lookup, the `drop` signal must have been cached in the pod's in-memory store from a previous successful lookup.
