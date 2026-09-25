# GraphQL Subscriptions — Design (DX03)

Status: implemented · Track: Developer Experience & SDK · Owner: platform

## Summary

GraphQL subscriptions give clients one interface for pull (queries) and push
(realtime) on `/api/graphql`. Five subscriptions are exposed:

| Subscription       | Arguments (all validated)                            | Source feed channel(s)                |
| ------------------ | ---------------------------------------------------- | ------------------------------------- |
| `transactionAdded` | `contract` (C… strkey), `account` (G…/M… strkey)     | `transactions`, `graphql.transaction` |
| `eventEmitted`     | `contract`, `eventType`, `topic`                     | `events`, `graphql.event`             |
| `alertTriggered`   | `severity` (case-insensitive)                        | `alerts`, `graphql.alert`             |
| `ledgerHead`       | —                                                    | `ledgers`; derived from tx/events     |
| `contractActivity` | `address` (required C… strkey), `kinds: [TRANSACTION | EVENT]`                               | `transactions`, `events` |

## Problem

Before this change the `Subscription` type existed in the schema but:

1. Nothing ever published to it — the indexer publishes to the feed bus
   (`feed.message`), never to the `graphql.*` events — so subscribers received
   nothing.
2. Filter arguments (`contract`, `account`, …) were declared but ignored.
3. There was no admission control, validation, metrics or kill switch.

## Architecture

```
indexer ──► FeedOrchestrator ──► feedPublisher ──► eventBus('feed.message') ──┬─► streamingServer (SSE/WS feed)
                                                    (Redis pub/sub or memory)  │
                                                                               └─► bridgeRealtimeMessage()
                                                                                     │ validate (zod) + map
                                                                                     │ ledger-head tracker
                                                                                     ▼
                                                                          graphql-yoga pubSub (per process)
                                                                          ├── TRANSACTION_ADDED / TRANSACTION_BY_CONTRACT:<C…>
                                                                          ├── EVENT_EMITTED     / EVENT_BY_CONTRACT:<C…>
                                                                          ├── CONTRACT_ACTIVITY:<C…>
                                                                          ├── LEDGER_HEAD
                                                                          └── ALERT_TRIGGERED
                                                                                     ▼
                                              POST /api/graphql  Accept: text/event-stream  (GraphQL over SSE)
```

- **Single source of truth.** GraphQL subscriptions consume the _same_
  bus messages as `/api/v1/feed/sse` and the feed WebSocket, so the three
  transports cannot disagree. Multi-instance fan-out comes for free from the
  existing Redis-backed event bus.
- **Transport.** graphql-yoga's built-in GraphQL-over-SSE ("distinct
  connections" mode). Requests pass through the full Express middleware chain
  (`apiKeyAuth` → `tieredRateLimit` → metrics → audit log), so authentication,
  tier rate limits and rate-limit headers apply to the subscription request
  exactly as to any other request.
- **Keyed routing.** Contract-filtered streams subscribe to a topic keyed by
  the contract address. Routing cost is O(matching subscribers) rather than
  O(all subscribers); this took the 500-subscriber fan-out benchmark from
  ~10 s to well under 1 s.

### Data model

GraphQL payloads are the existing `Transaction`, `Event` and `Alert` types plus
two new types:

```graphql
enum LedgerHeadSource {
  LEDGER_FEED
  DERIVED
}
type LedgerHead {
  sequence: Int!
  closeTime: DateTime!
  hash: String
  txCount: Int
  source: LedgerHeadSource!
}

enum ContractActivityKind {
  TRANSACTION
  EVENT
}
type ContractActivity {
  kind: ContractActivityKind!
  contractAddress: String!
  ledgerSequence: Int!
  occurredAt: DateTime!
  transaction: Transaction # set when kind = TRANSACTION
  event: Event # set when kind = EVENT
}
```

`ledgerHead` is monotonic. A `LEDGER_FEED` observation (carries hash and
txCount) may upgrade a `DERIVED` head of the same sequence once; everything
else only advances. Deriving the head from transaction/event sequence numbers
is graceful degradation: the stream keeps advancing when the `ledgers` channel
is silent.

The feed `transactions` payload gained two additive fields
(`contractAddress`, `functionName`) so contract filtering is possible. The
feed `schemaVersion` stays `1` because the change is additive.

## Admission control and security

| Control          | Behaviour                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Authentication   | Standard `X-Api-Key` (optional, tiered) via `apiKeyAuth`, identical to REST.                        |
| Rate limiting    | Tier limits on the subscription request; plus concurrent-stream caps below.                         |
| Per-client cap   | `GQL_SUBSCRIPTION_MAX_PER_CLIENT` (default 10) streams per API key, or per IP if anonymous.         |
| Per-instance cap | `GQL_SUBSCRIPTION_MAX_GLOBAL` (default 5000) streams per process.                                   |
| Input validation | Strkey regexes for addresses; `[A-Za-z0-9_:.-]{1,64}` for tokens. Checked _before_ a slot is taken. |
| Query cost       | Existing depth (5) and complexity (1000) limits apply to subscription documents.                    |
| Data validation  | Every bus payload is schema-validated; corrupt messages are dropped and counted.                    |
| SSRF             | No outbound network I/O is introduced.                                                              |
| Least privilege  | Read-only: subscriptions never write, and only expose data already public via REST.                 |
| Kill switch      | Feature flag `graphqlSubscriptions` (env `ENABLE_GRAPHQL_SUBSCRIPTIONS`), per developer.            |

Slots are released exactly once when a stream ends for any reason
(completion, error, client disconnect — including a disconnect before the
first event). This is enforced by `withRelease()` and tested.

## Error taxonomy

All errors are GraphQL errors with `extensions.code`:

| Code                              | Meaning                                  | Client action                        |
| --------------------------------- | ---------------------------------------- | ------------------------------------ |
| `INVALID_SUBSCRIPTION_ARGUMENT`   | An argument failed validation (`field`). | Fix the request; do not retry.       |
| `SUBSCRIPTION_LIMIT_EXCEEDED`     | Per-client concurrent cap hit (`limit`). | Close a stream or multiplex filters. |
| `SUBSCRIPTION_CAPACITY_EXHAUSTED` | Instance cap hit (`retryAfterSeconds`).  | Retry with backoff.                  |
| `SUBSCRIPTIONS_DISABLED`          | Kill switch on (`fallback` endpoint).    | Use `/api/v1/feed/sse` or poll.      |
| `GRAPHQL_VALIDATION_FAILED` etc.  | Standard GraphQL/Yoga errors.            | Fix the document.                    |

## Failure behaviour

| Failure                      | Behaviour                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Redis event bus down         | Event bus falls back to in-process; each instance serves its own indexer's messages.       |
| Corrupt / unexpected payload | Dropped, `graphql_subscription_bridge_dropped_total{reason="invalid_payload"}`++ , warned. |
| Pub/sub throws               | Caught per message (`reason="handler_error"`); the next message is delivered normally.     |
| Capacity reached             | New streams rejected with a retryable error; existing streams unaffected.                  |
| Client disconnect            | Slot released, gauge decremented, iterator returned.                                       |
| Feature flag off             | New streams rejected; open streams run to completion; queries unaffected.                  |
| Indexer stalled              | Streams stay open with SSE keep-alives; `ledgerHead` stops advancing (observable).         |

These are covered by fault-injection tests in `tests/graphql-subscriptions.test.ts`
and the property test in `tests/graphql-subscriptions.perf.test.ts`.

## SLOs and error budgets

| SLO   | Objective                                              | Window | Error budget | Alerts                                    |
| ----- | ------------------------------------------------------ | ------ | ------------ | ----------------------------------------- |
| SLO-1 | ≥ 99.5 % of well-formed subscription requests admitted | 30 d   | 0.5 %        | fast burn 14.4× (1 h), slow burn 6× (6 h) |
| SLO-2 | ≤ 0.1 % of bridged messages fail with `handler_error`  | 30 d   | 0.1 %        | `GraphQLSubscriptionBridgeErrors`         |
| SLO-3 | Bridge p99 < 5 ms                                      | 30 d   | —            | `GraphQLSubscriptionBridgeLatencyHigh`    |

Dashboard: `grafana/dashboards/graphql-subscriptions.json`. Alerts:
`prometheus/alerts.yml` group `soroban_explorer_graphql_subscriptions`.

Metrics (Prometheus via `prom-client`, the repo's metrics pipeline; the OTel
collector scrapes `/metrics`):

- `graphql_subscriptions_active{topic}` (gauge)
- `graphql_subscription_admissions_total{topic,outcome}` — `accepted`,
  `rejected_limit`, `rejected_capacity`, `rejected_invalid`, `rejected_disabled`
- `graphql_subscription_messages_total{topic}`
- `graphql_subscription_bridge_dropped_total{reason}` — `invalid_payload`,
  `malformed_envelope`, `handler_error`
- `graphql_subscription_bridge_duration_seconds` (histogram)

## Capacity and performance budgets

Projected peak per instance: **200 concurrent streams, 40 messages/s** (Stellar
closes a ledger every ~5 s; ~200 Soroban tx+events per ledger). 10× peak is
therefore **2000 streams at 400 messages/s**.

| Check                                        | Budget                                                         | Where enforced                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bridge 20 000 messages                       | < 2.5 s                                                        | `tests/graphql-subscriptions.perf.test.ts` (every CI run)                                              |
| Fan-out 1000 msgs → 500 filtered subscribers | zero loss, < 5 s                                               | same                                                                                                   |
| Property: 5000 random payloads               | never throws, never forwards invalid data                      | same                                                                                                   |
| Soak 10× peak over real HTTP/SSE             | zero loss, p99 ≤ 250 ms, heap growth ≤ 256 MB, no leaked slots | `tests/load/graphql-subscriptions-soak.ts`, `.github/workflows/soak.yml` (60 s on PRs, 30 min nightly) |

Measured locally (2000 streams, 394 msg/s achieved, 20 s): 157 600
deliveries, p50 57 ms, p99 110 ms, 0 lossy streams, heap +6 MB, 0 leaked slots.

## Rejected alternatives

- **graphql-ws (WebSocket) transport.** Requires a new dependency and a second
  upgrade handler beside `src/ws/websocketServer.ts`. SSE is built into
  graphql-yoga, passes through the existing HTTP middleware (auth, rate
  limits, audit log) unchanged and works through every proxy the REST API
  already works through. Can be added later without schema changes.
- **Publishing to GraphQL from the indexer directly.** Would create a second
  realtime pipeline that could diverge from the feed; bridging the bus keeps
  one pipeline.
- **Per-subscriber filtering on a single topic.** Simple, but O(all
  subscribers) per message; measured 10× slower at 500 subscribers.
- **Persisted replay for GraphQL streams.** The feed SSE endpoint already
  offers `Last-Event-ID` replay; GraphQL clients needing gap-free history
  should pair a query (`transactions(cursor:)`) with the subscription.

## Compatibility and migration

- Existing subscriptions keep their names, arguments and return types.
- Behaviour change: filter arguments are now honoured and validated. Clients
  that passed malformed filters previously received _every_ message; they now
  receive `INVALID_SUBSCRIPTION_ARGUMENT`. Fix: pass a valid strkey or omit the
  filter.
- `publishTransaction/publishEvent/publishAlert` keep working and go through
  the same validation path.

## Rollback

1. Immediate, no deploy: set `ENABLE_GRAPHQL_SUBSCRIPTIONS=false` (or flip the
   `graphqlSubscriptions` flag via `PUT /api/v1/admin/feature-flags/graphqlSubscriptions`).
   New streams are rejected with `SUBSCRIPTIONS_DISABLED`; queries unaffected.
2. Full: revert the DX03 commit. No database migration is involved; the only
   persisted artefact is the feature-flag row, which is ignored by older code.

Rehearsal: the kill-switch path is exercised by the end-to-end test
`kill switch: ENABLE_GRAPHQL_SUBSCRIPTIONS=false yields SUBSCRIPTIONS_DISABLED`.
