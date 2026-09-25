# Generating Clients for Other Languages

The OpenAPI document at `GET /api/v1/openapi.json` is the source of truth.
Two supported paths:

## 1. In-repo emitter (first-party SDKs)

`scripts/sdk/generate.ts` normalizes the spec once
(`src/lib/openapi/normalize.ts`: stable operation ids, merged/synthesized
params, `:param` → `{param}`) and runs every registered emitter. To add a
language:

1. Create `scripts/sdk/emit-<lang>.ts` exporting an `Emitter`
   (`({ doc, ops, fingerprint }) => [{ path, content }]`). See
   `emit-python.ts` (~150 lines) as the template.
2. Register it in `scripts/sdk/emitters.ts`.
3. Add curated method names to `scripts/sdk/parity.ts` if you add a wrapper.
4. `npm run sdk:generate`, commit; CI enforces drift and semver.

Benefits: identical operation ids across TS/Python/console, deterministic
output, drift + breaking-change gates for free.

## 2. openapi-generator (community / quick start)

```bash
curl -s http://localhost:3000/api/v1/openapi.json > openapi.json
docker run --rm -v "$PWD:/local" openapitools/openapi-generator-cli:v7.8.0 generate \
  -i /local/openapi.json -g go -o /local/out/go \
  --skip-validate-spec   # the spec contains a few dangling $refs
```

Notes:

- The spec has no `operationId`s; openapi-generator derives its own names,
  which will differ from the first-party ids. Prefer path 1 for anything you
  publish.
- Set the server URL to your deployment (`/api/v1` is relative).
- Auth: header `X-Api-Key` (security scheme `ApiKeyAuth`).
- Rate limits: honour `Retry-After` on 429 and read `X-RateLimit-*` headers.
- Errors use `{ "error": string, "code"?: string, … }`.
