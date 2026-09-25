# Python Client — Design (DX02)

Status: implemented · Package: `packages/python-client` (`soroban-explorer-client` 1.0.0)

## Shape: generated core + thin wrapper

| Layer                                                                    | File                              | Source                                   |
| ------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------- |
| Operation table (method, path, params with types/enums/bounds, body)     | `soroban_explorer/_operations.py` | generated (`scripts/sdk/emit-python.ts`) |
| Models (`TypedDict` per component schema)                                | `soroban_explorer/models.py`      | generated                                |
| Transport, retries, rate limits, pagination, SSE feed, curated resources | `soroban_explorer/client.py`      | hand-written                             |
| Error taxonomy                                                           | `soroban_explorer/errors.py`      | hand-written                             |

Both generated files come from the same normalizer as the TypeScript SDK and
the try-it console (`src/lib/openapi/normalize.ts`), so operation ids,
parameters and coverage are identical across clients. `npm run sdk:check`
fails CI on drift; `npm run sdk:breaking` enforces semver for the Python
package version too (`docs/sdk/versioning.md`).

## Decisions

- **Standard library only** (`urllib`, `json`, `logging`). Rejected
  `requests`/`httpx`: new dependencies for users and for our supply chain;
  quant/analytics environments often pin these, and version conflicts are the
  top adoption blocker for SDKs. Users needing async can wrap calls in
  `asyncio.to_thread`.
- **Table-driven, not one method per operation.** 494 generated methods would
  be unreadable and still untyped at the response level; a validated
  `call(id, …)` plus curated methods for common paths keeps the wrapper small
  and 100 % complete.
- **`object`, never `Any`**, for unrepresentable schemas; TypedDicts use
  `total=False` because the spec rarely marks response fields required.
- **Rejected: openapi-generator's Python client** as the shipped artefact —
  large, pydantic-dependent, and fails on this spec's dangling `$ref`s. It
  remains a supported path for other languages (see
  [generating-clients.md](../generating-clients.md)).

## Failure behaviour

Identical policy to the TypeScript SDK: 429 retried for all methods; 502/503/
504, timeouts and network errors retried for idempotent methods; POST/PATCH
5xx never retried; `Retry-After` honoured up to `max_retry_delay`; telemetry
hook exceptions swallowed and logged.

## Security

http(s)-only base URL, credentials in URLs rejected, key sent only as
`X-Api-Key`, redacted from `repr(client)`, never logged; path params
percent-encoded with dot segments rejected; unknown query params rejected.

## SLOs / telemetry

Client-side: `on_request` events. Server-side, SDK traffic is identified by
`User-Agent: soroban-explorer-client-py/*` in the existing HTTP metrics and
covered by the API SLO dashboards.

## Rollback

`pip install soroban-explorer-client==<previous>`; yank a bad release on PyPI
(`pip` then skips it for unpinned installs). Repository: revert the DX02
commit — no server change is involved.
