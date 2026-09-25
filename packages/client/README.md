# @soroban-explorer/client

Official TypeScript SDK for the Soroban Smart Block Explorer API.

- **Every REST operation**, fully typed, generated from the OpenAPI spec
  (`client.call('<operationId>', …)`), plus curated methods for common tasks.
- **Typed errors** (`NotFoundError`, `RateLimitError`, …), automatic retries
  with backoff and `Retry-After`, timeouts, rate-limit info on every error.
- **Realtime**: GraphQL subscriptions over SSE and the feed WebSocket/SSE.
- Zero runtime dependencies. Node ≥ 18 or any modern browser.

## Install

```bash
npm install @soroban-explorer/client
```

## Five-minute quickstart

```ts
import { SorobanClient } from '@soroban-explorer/client';

const client = new SorobanClient({
  baseUrl: 'http://localhost:3000/api/v1', // default: https://api.soroban.network/api/v1
  apiKey: process.env.SOROBAN_API_KEY, // optional; public tier without it
});

const page = await client.transactions.list({ limit: 5 });
const tx = await client.transactions.get('9f…');
```

Runnable: [`examples/quickstart.ts`](./examples/quickstart.ts) (executed in CI
against a live API).

## Any operation

Operation ids are listed in the
[parity matrix](../../docs/sdk/parity-matrix.md) and the
[API console](/api/try). Parameters and responses are typed.

```ts
const stats = await client.call('getContractsByAddressStats', { path: { address: 'C…' } });
const hooks = await client.call('postWebhooks', { body: { url: 'https://example.com/hook' } });
```

Invalid parameters throw `RequestValidationError` before any request is sent.

## Pagination

```ts
for await (const tx of client.paginate('getTransactions', { query: { limit: 100 } })) {
  console.log(tx);
}
```

## Errors

```ts
import { NotFoundError, RateLimitError, SorobanApiError } from '@soroban-explorer/client';

try {
  await client.transactions.get(hash);
} catch (err) {
  if (err instanceof NotFoundError) …;
  else if (err instanceof RateLimitError) console.log(err.retryAfterMs, err.rateLimit);
  else if (err instanceof SorobanApiError) console.log(err.status, err.code, err.requestId);
}
```

| Class                                                                                                                                                                                             | When                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `RequestValidationError`                                                                                                                                                                          | Invalid params (request not sent) |
| `NetworkError`                                                                                                                                                                                    | Transport failure                 |
| `TimeoutError`                                                                                                                                                                                    | No response within `timeoutMs`    |
| `BadRequestError` 400 · `AuthenticationError` 401 · `PermissionDeniedError` 403 · `NotFoundError` 404 · `ConflictError` 409 · `UnprocessableError` 422 · `RateLimitError` 429 · `ServerError` 5xx | Non-2xx response                  |

## Options

| Option            | Default    | Notes                                                       |
| ----------------- | ---------- | ----------------------------------------------------------- |
| `apiKey`          | —          | Sent as `X-Api-Key`                                         |
| `baseUrl`         | public API | http(s) only; credentials in the URL are rejected           |
| `timeoutMs`       | 10 000     | Per attempt                                                 |
| `maxRetries`      | 2          | 429/502/503/504/network for idempotent methods; 429 for all |
| `maxRetryDelayMs` | 30 000     | Cap for backoff and `Retry-After`                           |
| `fetch`           | global     | Custom fetch implementation                                 |
| `logger`          | none       | `{ debug, warn }`; the SDK is silent by default             |
| `onRequest`       | none       | Per-attempt telemetry event (wire to OpenTelemetry etc.)    |

## Realtime

```ts
for await (const data of client.realtime.graphql(
  'subscription($c: String!) { contractActivity(address: $c) { kind ledgerSequence } }',
  { c: 'C…' },
)) {
  console.log(data);
}

const feed = client.realtime.feed(); // SorobanFeed (1.0 API, unchanged)
feed.connectSSE(['transactions']).on('message', console.log);
```

## Compatibility

1.x keeps every 1.0 export (`SorobanFeed`, `ReputationClient`, default export).
See [versioning policy](../../docs/sdk/versioning.md).

## License

MIT
