# soroban-explorer-client (Python)

Reference Python client for the Soroban Smart Block Explorer API. The
operation table and TypedDict models are **generated from the OpenAPI spec**;
a thin hand-written wrapper adds auth, retries, rate-limit handling,
pagination and typed errors. Standard library only — no dependencies.

## Install

```bash
pip install soroban-explorer-client        # Python ≥ 3.9
```

## Quickstart (≤ 5 minutes)

```python
from soroban_explorer import Client

client = Client(base_url="http://localhost:3000/api/v1", api_key=None)  # key optional
page = client.transactions.list(limit=5)
tx = client.transactions.get("9f…")
```

Runnable: [`examples/quickstart.py`](./examples/quickstart.py) — executed in CI
against a live API.

## Any operation

Every operation in [the parity matrix](../../docs/sdk/parity-matrix.md):

```python
stats = client.call("getContractsByAddressStats", path={"address": "C…"})
hook = client.call("postWebhooks", body={"url": "https://example.com/hook"})
```

Parameters are validated against the spec before sending
(`RequestValidationError`).

## Pagination

```python
for tx in client.paginate("getTransactions", query={"limit": 100}):
    ...
```

## Errors, retries and rate limits

```python
from soroban_explorer import NotFoundError, RateLimitError, ApiError

try:
    client.transactions.get(h)
except NotFoundError:
    ...
except RateLimitError as err:
    print(err.retry_after, err.rate_limit.remaining, err.rate_limit.tier)
except ApiError as err:
    print(err.status, err.code, err.request_id, err.body)
```

429 is retried for every method and 502/503/504/network/timeouts for
idempotent methods (`max_retries`, default 2), with exponential backoff +
jitter and `Retry-After` honoured (capped by `max_retry_delay`).

## Realtime

```python
for event, data in client.stream_feed(["transactions", "events"]):
    print(event, data)
```

## Observability

Logging uses the `soroban_explorer` logger (silent unless configured).
`Client(on_request=callback)` receives a `RequestEvent` per attempt (operation
id, status, duration, retry decision, request id, rate-limit info) — map it to
OpenTelemetry or metrics in your app.

## Models

`soroban_explorer.models` contains a `TypedDict` per schema in the spec
(e.g. `models.Transaction`) for static typing of responses.
