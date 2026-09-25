# Try-it API Console — Design (DX04)

Status: implemented · Track: Developer Experience & SDK · Owner: platform

## Summary

`/api/try` is an authenticated, in-browser console that builds requests from
the OpenAPI spec and executes them against the live API. It complements (does
not replace) Swagger UI at `/api/docs`:

| Capability                               | Swagger UI                   | Try-it console                                                                |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Every documented operation               | yes                          | yes (derived from the same spec, 100 % coverage asserted in CI)               |
| API-key injection                        | manual                       | once per tab, optional `sessionStorage`, never in URLs                        |
| Shareable, pre-filled request links      | no                           | yes (`#try=v1.…`, key excluded)                                               |
| Rate-limit / request-id headers surfaced | no                           | yes (`X-RateLimit-*`, `Retry-After`, `X-Request-Id`, `Deprecation`, `Sunset`) |
| Typed param validation before sending    | partial                      | yes (integer/number/boolean/enum/min/max, required)                           |
| `curl` equivalent                        | yes                          | yes, with the key as `$SOROBAN_API_KEY`                                       |
| Available in production                  | only with `ENABLE_DOCS=true` | yes, behind the `tryItConsole` flag                                           |

## Architecture

```
browser ── GET /api/try ─────────────► HTML shell (no inline script)
        ── GET /api/try/app.js ──────► TryItCore + DOM app (ETag, 5 min cache)
        ── GET /api/try/catalog.json ► buildCatalog(swaggerSpec) (memoised, ETag)
        ── fetch /api/v1/... ────────► normal API path: apiKeyAuth → tieredRateLimit
           X-Api-Key, X-Client: try-it       → audit log → metrics → tryItAttribution
```

- **No proxy.** The browser calls `/api/v1` directly. There is no server-side
  fetch, so the console adds no SSRF surface, and every request is subject to
  exactly the same auth, rate limits, audit logging and metrics as any other
  client. Least privilege follows: the console can do nothing the key holder
  could not already do with `curl`.
- **One spec interpreter.** `src/lib/openapi/normalize.ts` turns the OpenAPI
  document into normalized operations (stable ids, merged/synthesized
  params, body schemas). The console catalog and both SDK generators
  (TypeScript DX01, Python DX02) use it, so an operation looks the same in all
  three.
- **Shipped as strings.** The runtime image copies only `dist/`, so the page
  and script are TypeScript string modules. The script's pure logic
  (`TryItCore`) is tested by evaluating the exact shipped string in a Node `vm`.

### Data model

Catalog (`GET /api/try/catalog.json`):

```ts
interface TryItCatalog {
  title: string;
  specVersion: string;
  basePath: string; // always same-origin relative, e.g. "/api/v1"
  operationCount: number;
  tags: string[];
  etag: string;
  operations: Array<{
    id: string; // e.g. "getTransactionsByHash"
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string; // "/transactions/{hash}"
    summary: string;
    description: string;
    tags: string[];
    deprecated: boolean;
    params: Array<{
      name;
      in: 'path' | 'query';
      required;
      type;
      itemType?;
      enum?;
      minimum?;
      maximum?;
      default?;
      description?;
    }>;
    body: { required: boolean; contentType: string; example: string } | null;
    responses: Array<{ status: string; description: string }>;
  }>;
}
```

Share link: `/api/try#try=v1.<base64url(JSON)>` where JSON is
`{ o: operationId, p?: {path params}, q?: {query params}, b?: body }`.

- Lives in the URL **fragment**, so it is never sent to the server, proxies or
  logs.
- Never contains the API key or any header.
- Versioned (`v1.`); ≤ 8 KB; decoded with strict validation — unknown
  operations are rejected, unknown params are dropped and reported, non-string
  values are rejected.

## Security

| Threat                    | Control                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSRF / open redirect      | No server-side fetch. Browser refuses non-relative `basePath` and any URL whose origin ≠ page origin or path escapes `basePath`. The server also ignores absolute `servers[].url`. |
| Path traversal via params | Path params are `encodeURIComponent`-encoded; `.`/`..` rejected. Property-tested.                                                                                                  |
| XSS                       | All rendering via `textContent`; no `innerHTML`/`eval`; CSP `script-src 'self'` (no inline script).                                                                                |
| Key leakage               | Key sent only as `X-Api-Key`; never in URL, share link, `curl` output or DOM text; optional `sessionStorage` (tab-scoped). `Referrer-Policy: no-referrer` on the page.             |
| Accidental writes         | Non-GET requests require an explicit confirmation checkbox.                                                                                                                        |
| Abuse / rate limits       | Console assets and API calls pass through `tieredRateLimit`; console calls count against the key's tier.                                                                           |
| Clickjacking              | Global `frame-ancestors 'none'` / `X-Frame-Options: DENY`.                                                                                                                         |
| Input validation          | Typed param validation client-side; server-side validation is unchanged and authoritative.                                                                                         |

## Error taxonomy

| Where                   | HTTP | `code`                      | Meaning / client behaviour                                                                                               |
| ----------------------- | ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/api/try/*`            | 404  | `FEATURE_DISABLED`          | Kill switch on; `fallback` points at the raw spec.                                                                       |
| `/api/try/catalog.json` | 503  | `TRYIT_CATALOG_UNAVAILABLE` | Spec could not be processed; `Retry-After: 30`. The page shows a link to `/api/v1/openapi.json`.                         |
| Console (client-side)   | —    | validation messages         | Request not sent; errors listed inline.                                                                                  |
| Console (client-side)   | —    | `Timed out after 30 s`      | Request aborted via `AbortController`.                                                                                   |
| Console (client-side)   | —    | share-link errors           | `Unsupported share link version`, `Share link is corrupted`, `Operation no longer exists: <id>`, `Share link too large`. |
| API responses           | any  | as documented per endpoint  | Rendered verbatim with status, timing and headers.                                                                       |

## Failure behaviour

| Failure                          | Behaviour                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Spec processing throws           | Catalog 503 (not cached); page and script still load; next request retries automatically. |
| API down / 5xx                   | Response rendered as-is; counted in `tryit_api_requests_total{status_class="5xx"}`.       |
| Rate limited                     | 429 rendered with `Retry-After` and `X-RateLimit-*`; status line says "Rate limited".     |
| Share link for removed operation | Clear error, console still usable.                                                        |
| `sessionStorage` unavailable     | Key kept in memory only.                                                                  |
| Flag off                         | 404 on all console assets; API unaffected.                                                |

## SLOs and error budgets

| SLO   | Objective                                           | Window | Budget | Alert                                  |
| ----- | --------------------------------------------------- | ------ | ------ | -------------------------------------- |
| SLO-1 | ≥ 99.9 % of catalog responses are not 503           | 30 d   | 0.1 %  | `TryItCatalogUnavailable` (14.4× burn) |
| SLO-2 | ≤ 1 % of console-originated API requests return 5xx | 30 d   | 1 %    | `TryItConsoleRequests5xx`              |
| SLO-3 | Catalog build p99 < 1 s                             | 30 d   | —      | dashboard                              |

Metrics: `tryit_asset_requests_total{asset,status}`, `tryit_catalog_builds_total{outcome}`,
`tryit_catalog_build_duration_seconds`, `tryit_api_requests_total{method,status_class}`.
Dashboard: `grafana/dashboards/tryit-console.json`.

## Capacity and performance budgets

Projected peak: 5 console sessions/s (page + script + catalog = 15 req/s).
10× peak = 50 sessions/s = 150 req/s.

| Check                                  | Budget                                                         | Enforced in                                                                               |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Build catalog from the real spec       | < 3 s, < 2 MB                                                  | `tests/api/tryit.test.ts` (CI)                                                            |
| 1000 cached catalog requests (in-proc) | < 15 s                                                         | same                                                                                      |
| Load at 10× peak over real HTTP        | 0 failures, p99 ≤ 200 ms, ≥ 90 % of target rate, heap ≤ 128 MB | `tests/load/tryit-load.ts` via `.github/workflows/soak.yml` (60 s on PRs, 30 min nightly) |

Measured locally: real spec → 494 operations, 254 KB catalog, built in ~50 ms;
20 s at 150 req/s: p50 2 ms, p99 22 ms, 0 failures, heap +2 MB.

## Rejected alternatives

- **Server-side request proxy.** Would let the console set arbitrary headers
  and targets but creates an SSRF surface and double-counts rate limits.
- **Extending Swagger UI with plugins.** Swagger UI requires inline scripts
  (CSP relaxation) and cannot express share links without storing state.
- **Server-stored share links.** Needs storage, retention and PII handling;
  fragment links are stateless and never reach logs.
- **Bundling a SPA framework.** New dependencies and a build step for a
  single page; plain ES2017 keeps it dependency-free.

## Compatibility and migration

Purely additive: new routes under `/api/try`, a new header value
(`X-Client: try-it`) that the API ignores except for attribution. No database
changes. Share links are versioned (`v1.`); a future `v2` must keep decoding
`v1`.

## Rollback

1. Kill switch: `ENABLE_TRY_IT=false` or
   `PUT /api/v1/admin/feature-flags/tryItConsole {"defaultEnabled": false}`.
2. Code: revert the DX04 commit; nothing persisted.

Rehearsed in CI by `kill switch: returns 404 FEATURE_DISABLED for every asset`.
