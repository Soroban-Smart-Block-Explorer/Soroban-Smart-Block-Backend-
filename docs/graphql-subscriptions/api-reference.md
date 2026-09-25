# GraphQL Subscriptions — API Reference

Endpoint: `POST /api/graphql` (also `GET` with query-string parameters)
Transport: GraphQL over Server-Sent Events — send `Accept: text/event-stream`.
Auth: optional `X-Api-Key` header (tiered rate limits, as for REST).

## Request

```http
POST /api/graphql HTTP/1.1
Content-Type: application/json
Accept: text/event-stream
X-Api-Key: dev_xxxxxxxx

{"query":"subscription($c: String!) { contractActivity(address: $c) { kind ledgerSequence transaction { hash functionName } event { id topicSymbol } } }",
 "variables":{"c":"CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE"}}
```

## Response stream

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 1767225600
X-RateLimit-Tier: developer

:

event: next
data: {"data":{"contractActivity":{"kind":"TRANSACTION","ledgerSequence":51234567,"transaction":{"hash":"9f…","functionName":"transfer"},"event":null}}}

event: next
data: {"data":{"contractActivity":{"kind":"EVENT","ledgerSequence":51234567,"transaction":null,"event":{"id":"9f…-0","topicSymbol":"transfer"}}}}
```

`:` lines are keep-alives. Closing the HTTP connection ends the subscription and
frees its slot.

## Subscriptions

### `transactionAdded(contract: String, account: String): Transaction!`

`contract` — contract strkey (`C` + 55 base32 chars). `account` — source account
strkey (`G…` or muxed `M…`). Both optional; combined with AND.

```graphql
subscription {
  transactionAdded(contract: "C…") {
    hash
    ledgerSequence
    ledgerCloseTime
    sourceAccount
    functionName
    status
    feeCharged
  }
}
```

### `eventEmitted(contract: String, eventType: String, topic: String): Event!`

`eventType` and `topic` (matches `topicSymbol`) are 1–64 chars of `[A-Za-z0-9_:.-]`.

```json
{
  "data": {
    "eventEmitted": {
      "id": "9f…-0",
      "contractAddress": "C…",
      "eventType": "contract",
      "topicSymbol": "transfer",
      "decoded": { "amount": "100" },
      "ledgerSequence": 51234567,
      "ledgerCloseTime": "2026-09-25T12:00:00.000Z"
    }
  }
}
```

### `alertTriggered(severity: String): Alert!`

`severity` is matched case-insensitively.

```json
{
  "data": {
    "alertTriggered": {
      "id": "a1",
      "severity": "high",
      "title": "Reentrancy pattern",
      "txHash": "9f…",
      "contractAddress": "C…",
      "createdAt": "2026-09-25T12:00:00.000Z"
    }
  }
}
```

### `ledgerHead: LedgerHead!`

Emits whenever the observed head advances.

```json
{"data":{"ledgerHead":{"sequence":51234568,"closeTime":"2026-09-25T12:00:05.000Z","hash":null,"txCount":null,"source":"DERIVED"}}}
{"data":{"ledgerHead":{"sequence":51234568,"closeTime":"2026-09-25T12:00:05.000Z","hash":"ab12…","txCount":212,"source":"LEDGER_FEED"}}}
```

### `contractActivity(address: String!, kinds: [ContractActivityKind!]): ContractActivity!`

`kinds` defaults to both `TRANSACTION` and `EVENT`.

## Errors

Errors arrive as a `next` frame with `errors`, followed by `complete`:

```text
event: next
data: {"errors":[{"message":"Too many concurrent subscriptions (limit 10 per client)","locations":[{"line":1,"column":16}],"path":["ledgerHead"],"extensions":{"code":"SUBSCRIPTION_LIMIT_EXCEEDED","limit":10}}]}

event: complete
data:
```

| `extensions.code`                 | Extra fields        | Retry?                 |
| --------------------------------- | ------------------- | ---------------------- |
| `INVALID_SUBSCRIPTION_ARGUMENT`   | `field`             | No                     |
| `SUBSCRIPTION_LIMIT_EXCEEDED`     | `limit`             | After closing a stream |
| `SUBSCRIPTION_CAPACITY_EXHAUSTED` | `retryAfterSeconds` | Yes, with backoff      |
| `SUBSCRIPTIONS_DISABLED`          | `fallback`          | Use the fallback       |

HTTP-level errors (before the stream opens) use the REST error envelope:
`429` with `Retry-After` and `X-RateLimit-*` headers when the tier limit is
exceeded; `401/403` for a revoked or IP-restricted API key.

## Client examples

JavaScript (no library):

```js
const res = await fetch('https://api.example.com/api/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': KEY },
  body: JSON.stringify({ query: 'subscription { ledgerHead { sequence } }' }),
});
const reader = res.body.getReader();
// parse `event: next` / `data:` frames
```

With `graphql-sse` (client library) use `createClient({ url, singleConnection: false })`.

## Versioning

Subscriptions follow the GraphQL schema's additive-only policy
(`docs/api-versioning.md`): fields and arguments are never removed or
retyped without a deprecation period announced via `@deprecated`.
