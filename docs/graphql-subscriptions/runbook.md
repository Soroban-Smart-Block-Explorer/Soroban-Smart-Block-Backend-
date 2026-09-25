# GraphQL Subscriptions — Runbook

Design: [design.md](./design.md) · API: [api-reference.md](./api-reference.md) ·
Dashboard: `grafana/dashboards/graphql-subscriptions.json` · Alerts:
`prometheus/alerts.yml` → `soroban_explorer_graphql_subscriptions`

## Run

Subscriptions are served by the API process on `/api/graphql`; there is no
separate service. `docker compose up` starts everything needed.

| Setting                                | Default                     | Effect                                                |
| -------------------------------------- | --------------------------- | ----------------------------------------------------- |
| `ENABLE_GRAPHQL_SUBSCRIPTIONS`         | unset (flag default **on**) | `false` rejects new streams (kill switch)             |
| `GQL_SUBSCRIPTION_MAX_PER_CLIENT`      | 10                          | Concurrent streams per API key (or IP if anonymous)   |
| `GQL_SUBSCRIPTION_MAX_GLOBAL`          | 5000                        | Concurrent streams per API instance                   |
| `GQL_MAX_DEPTH` / `GQL_MAX_COMPLEXITY` | 5 / 1000                    | Existing document limits, also apply to subscriptions |
| `EVENT_BUS_URL`                        | `CACHE_URL` or `memory://`  | Redis for cross-instance fan-out                      |

### Manual verification

```bash
docker compose up -d
# terminal 1 — open a stream
curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{"query":"subscription { ledgerHead { sequence closeTime source } }"}' \
  http://localhost:3000/api/graphql
# Expect ":" keep-alive lines, then `event: next` frames as the indexer advances.

# terminal 2 — confirm the stream is counted
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics | grep graphql_subscriptions_active
```

## Debug

| Symptom                                   | Check                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream opens but no events                | `graphql_subscription_messages_total` rising? If not, is the indexer publishing? (`indexer_last_ledger`, feed SSE `/api/v1/feed/sse?channels=transactions`) |
| Some instances deliver, others don't      | Redis event bus: logs `[event-bus] Redis unavailable; falling back` ⇒ per-instance only.                                                                    |
| Client gets `SUBSCRIPTION_LIMIT_EXCEEDED` | Client exceeds `GQL_SUBSCRIPTION_MAX_PER_CLIENT`; advise multiplexing or raise the limit.                                                                   |
| Filtered stream silent                    | Filters are exact-match; verify the strkey and `eventType`/`topic` spelling.                                                                                |
| Stream closes immediately                 | Proxy buffering / timeouts: SSE needs `proxy_buffering off` and read timeout > 30 s.                                                                        |

Logs are structured JSON (`src/logger.ts`); grep for `[graphql-subscriptions]`.

### Invalid payloads

Alert `GraphQLSubscriptionInvalidFeedPayloads`. The bridge rejected messages from
the feed bus. Subscribers are protected; the issue is upstream.

1. `rate(graphql_subscription_bridge_dropped_total[5m])` by `reason`.
2. Logs: `[graphql-subscriptions] dropped feed message` with `channel`.
3. Inspect a raw message: `curl -N 'localhost:3000/api/v1/feed/sse?channels=<channel>'`.
4. A feed schema change must stay additive; fix the publisher
   (`src/feed/orchestrator.ts`) or extend the mapper in
   `src/graphql/subscriptionGateway.ts`.

### Bridge errors

Alert `GraphQLSubscriptionBridgeErrors` (SLO-2). Exceptions inside pub/sub
publish. Logs: `[graphql-subscriptions] bridge handler failed`. Messages after
the failure continue to flow (no manual action needed for recovery); a
sustained rate indicates a bug — roll back (below) and file an incident.

### Latency

Alert `GraphQLSubscriptionBridgeLatencyHigh` (SLO-3). Usually CPU saturation or
event-loop lag (`nodejs_eventloop_lag_seconds`). Scale out; check
`graphql_subscriptions_active` for a surge of unfiltered streams.

### Capacity exhausted

Alerts `GraphQLSubscriptionAdmissionBudgetFastBurn/SlowBurn` (SLO-1).

1. `sum(graphql_subscriptions_active)` per instance vs `GQL_SUBSCRIPTION_MAX_GLOBAL`.
2. Scale API replicas (HPA) — streams are spread by the load balancer.
3. If one client dominates, lower `GQL_SUBSCRIPTION_MAX_PER_CLIENT` or revoke the key.
4. Raise `GQL_SUBSCRIPTION_MAX_GLOBAL` only after confirming memory headroom
   (soak test: ~6 MB heap growth for 2000 streams).

## Recover

The bridge self-heals: a failing message never stops later ones, and slots are
released on disconnect. No manual recovery step exists or is needed for:
Redis outages (falls back to in-process), corrupt payloads, client disconnects.

## Rollback

1. **Kill switch (seconds, no deploy):** `ENABLE_GRAPHQL_SUBSCRIPTIONS=false`
   and restart, or without restart:
   `PUT /api/v1/admin/feature-flags/graphqlSubscriptions {"defaultEnabled": false}`.
   New streams get `SUBSCRIPTIONS_DISABLED` with `fallback: /api/v1/feed/sse`.
2. **Code rollback:** revert the DX03 commit and redeploy. No migrations.

Rehearsed by the end-to-end kill-switch test on every CI run.

## Load testing

```bash
# 10× projected peak, 30 minutes (nightly in CI)
node --expose-gc -r ts-node/register/transpile-only tests/load/graphql-subscriptions-soak.ts
# quick local smoke
SOAK_DURATION_SEC=20 node --expose-gc -r ts-node/register/transpile-only tests/load/graphql-subscriptions-soak.ts
```

Budgets are env-tunable (`SOAK_*`), but CI values are the contract; changing
them requires data in the PR.
