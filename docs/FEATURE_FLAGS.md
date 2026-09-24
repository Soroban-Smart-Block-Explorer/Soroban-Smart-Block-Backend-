# Feature Flags

DB-backed feature flags with **per-environment** and **per-developer** toggles
and **gradual rollout**, replacing the previous all-or-nothing gating of the
optional background services.

## Why

Previously each optional service (pool monitor, arbitrage scanner, fee
aggregator, and the privacy/composability/arbitrage WebSockets) was either fully
on or fully off, decided at boot by a single `ENABLE_*` env var that operators
set only after the required schema migration was applied. There was no way to:

- turn a feature on for a subset of accounts (gradual rollout),
- toggle a feature at runtime without a redeploy,
- override a feature per environment or per developer,
- distinguish "flag is off" from "schema is missing" in `/ready`.

## Resolution order

For a given flag, the most specific source wins:

| # | Source | Scope | Example |
|---|--------|-------|---------|
| 1 | DB `FeatureFlagOverride` (scopeType `developer`) | one developer | `PUT /api/v1/admin/feature-flags/poolMonitor/overrides/developer/<developerId>` |
| 2 | DB `FeatureFlagOverride` (scopeType `environment`) | one environment | override keyed by Stellar network name (`testnet`, `mainnet`, `devnet`) |
| 3 | Env var (`ENABLE_*` legacy or `FF_<KEY>` generic) | this deployment | `ENABLE_POOL_MONITOR=true` in the ConfigMap |
| 4 | Gradual rollout (`rolloutPercent`) | stable per-account bucket | 10 → ~10% of developers on, monotonically |
| 5 | DB `FeatureFlag.defaultEnabled` | all | `defaultEnabled=false` |

Anonymous callers (no `developerId`) skip the rollout bucket and fall through
to the default — a rollout needs a stable identity to target.

### Rollout semantics

`rolloutPercent` (0–100) on the flag row. Bucketing uses a stable FNV-1a hash
of `"{flagKey}:{developerId}"` mapped to 1–100, so:

- the same developer always lands in the same bucket (no flapping),
- raising the percentage only ever *adds* accounts (monotonic),
- 0 = off, 100 = fully on.

## Schema availability

Each flag in `src/feature-flags/registry.ts` may declare `requiredTables`. A
feature whose tables are missing (migration not yet applied) is **never
started**, no matter what the toggle says. This is the old "gated on schema
availability" behavior, now explicit:

- `/ready` reports the service as `"<service> (schema unavailable)"` instead of
  silently crashing, and
- `featureFlags.isAvailableSync(key)` / `featureFlags.shouldStartSync(key)` let
  callers distinguish "flag off" from "can't run yet".

## Code layout

| File | Responsibility |
|------|----------------|
| `src/feature-flags/registry.ts` | Declarative flag definitions (keys, descriptions, legacy env vars, required tables, built-in defaults) |
| `src/feature-flags/evaluate.ts` | Pure layered evaluation + deterministic rollout bucketing (no I/O) |
| `src/feature-flags/store.ts` | DB load/write with a 30 s TTL cache; seeds rows for registered flags |
| `src/feature-flags/schema.ts` | Cached `information_schema` table-existence checks |
| `src/feature-flags/index.ts` | Public `featureFlags` singleton: `isEnabledSync`, `isEnabled`, `isEnabledForDeveloper`, `isAvailableSync`, `shouldStartSync`, `list`, admin writes |
| `prisma/schema.prisma` | `FeatureFlag` + `FeatureFlagOverride` models (migration `20260825000000_feature_flags`) |
| `src/api/feature-flags.ts` | Admin API router (`/api/v1/admin/feature-flags`) |

## Usage

### Boot-time services (`src/services.ts`, `src/server.ts`)

```ts
if (featureFlags.shouldStartSync('poolMonitor')) {
  startPoolPriceMonitorImpl();
}
// else: reported in /ready → disabledServices as
//   "poolMonitor (flag off)"            — toggle is off
//   "poolMonitor (schema unavailable)"  — tables missing
```

`src/index.ts` calls `featureFlags.bootstrap()` before the servers start to
warm the cache and the schema check. It is best-effort: if the DB is
unreachable the system falls back to env vars + registry defaults (the old
behavior), so boot never blocks on the flag store.

### Request-scoped, per-developer gates

```ts
// after apiKeyAuth has populated req.apiKey.developerId
if (featureFlags.isEnabledForDeveloper('betaEndpoint', req.apiKey.developerId)) {
  // serve the beta behavior for this developer only
}
```

### Admin API (admin role; runtime, no redeploy)

All endpoints require a session with the `admin` role (`requireAuth` +
`requireRole('admin')`).

- `GET  /api/v1/admin/feature-flags` — list flags with resolved state, reason, availability, and overrides.
- `PUT  /api/v1/admin/feature-flags/:key` — body `{ "defaultEnabled": true }` and/or `{ "rolloutPercent": 10 }`.
- `PUT  /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue` — body `{ "enabled": true }`; `scopeType` ∈ `environment` \| `developer`.
- `DELETE /api/v1/admin/feature-flags/:key/overrides/:scopeType/:scopeValue` — remove an override.

Example — enable the pool monitor for the whole `testnet` environment, then
ramp it to 10% of developers everywhere else:

```bash
# environment override (testnet)
curl -X PUT localhost:3000/api/v1/admin/feature-flags/poolMonitor/overrides/environment/testnet \
  -H 'Authorization: Bearer <admin token>' -H 'Content-Type: application/json' \
  -d '{"enabled": true}'

# gradual rollout for everyone else
curl -X PUT localhost:3000/api/v1/admin/feature-flags/poolMonitor \
  -H 'Authorization: Bearer <admin token>' -H 'Content-Type: application/json' \
  -d '{"rolloutPercent": 10}'
```

### Environments

The "environment" scope key is the active Stellar network
(`config.stellarNetwork`: `testnet` / `mainnet` / `devnet`), matching the
per-network profile overlays in `k8s/configmap.yaml`.

## Caching / propagation

Flag rows and the schema table set are cached in-process for 30 s. Admin writes
invalidate the local cache immediately; other instances pick the change up
within the TTL. This is the standard tradeoff for a small, hot cache — use the
DB directly for anything that needs stronger consistency.
