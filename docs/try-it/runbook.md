# Try-it API Console — Runbook

Design: [design.md](./design.md) · API: [api-reference.md](./api-reference.md) ·
Dashboard: `grafana/dashboards/tryit-console.json` · Alerts: `prometheus/alerts.yml`
→ `soroban_explorer_tryit`

## Run

Served by the API process; no extra service. After `docker compose up`, open
`http://localhost:3000/api/try`.

| Setting         | Default                     | Effect                           |
| --------------- | --------------------------- | -------------------------------- |
| `ENABLE_TRY_IT` | unset (flag default **on**) | `false` → 404 `FEATURE_DISABLED` |

### Manual verification (≤ 5 minutes)

1. `docker compose up -d` and open `http://localhost:3000/api/try`.
2. Filter for `transactions`, pick `GET /transactions`, set `limit` = 1, **Send**.
   Expect `200`, timing, and `x-ratelimit-*` headers under the status line.
3. Paste an API key in the header field, tick "remember for this tab", resend —
   `x-ratelimit-tier` reflects the key's tier.
4. **Copy share link**, open it in a private window: the same operation and
   parameters are pre-filled; the key field is empty.
5. `curl -s localhost:3000/metrics | grep tryit_` shows the page, script,
   catalog and `tryit_api_requests_total{method="GET",status_class="2xx"}`.

## Debug

| Symptom                            | Check                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Blank page                         | Browser console: CSP violation? `/api/try/app.js` must be same-origin.                                                                   |
| "Could not load the API catalog"   | `curl -i /api/try/catalog.json`; logs `[try-it] catalog build failed`.                                                                   |
| Operation missing                  | It is missing from `/api/v1/openapi.json` — fix the `@swagger` block. `[swagger] Skipped … malformed docs` on stderr lists broken files. |
| Requests 401/403 from console only | Key IP/endpoint/domain allowlists apply (`allowedDomains` checks `Origin`).                                                              |
| 429s                               | Tier limit reached; the console shows `Retry-After`.                                                                                     |

### Catalog unavailable

Alert `TryItCatalogUnavailable`.

1. `curl -i localhost:3000/api/try/catalog.json` → 503 `TRYIT_CATALOG_UNAVAILABLE`.
2. Logs: `[try-it] catalog build failed` with the error.
3. The catalog is rebuilt on the next request after a failure — no restart is
   needed once the cause is fixed (typically a malformed OpenAPI block
   deployed in a route file). Roll back that deploy if necessary.
4. Meanwhile users are pointed at `/api/v1/openapi.json`.

### Console requests failing

Alert `TryItConsoleRequests5xx`. The console only relays API responses; this
mirrors an API problem. Follow the API 5xx runbook (`HTTP5xxSurgeRatio`) and
filter logs for `[try-it] request` to see which routes fail.

## Recover

Nothing to recover manually: the catalog self-heals on the next request,
share links are stateless, and no data is stored server-side.

## Rollback

1. `ENABLE_TRY_IT=false` (restart) or, without restart,
   `PUT /api/v1/admin/feature-flags/tryItConsole {"defaultEnabled": false}`.
2. Revert the DX04 commit. No migrations.

## Load testing

```bash
node --expose-gc -r ts-node/register/transpile-only tests/load/tryit-load.ts           # 30 min, 10× peak
TRYIT_DURATION_SEC=20 node -r ts-node/register/transpile-only tests/load/tryit-load.ts  # smoke
```
