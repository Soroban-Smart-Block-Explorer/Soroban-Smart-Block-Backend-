# SDK Versioning & Deprecation Policy

Applies to every first-party SDK generated from the OpenAPI spec
(`@soroban-explorer/client`, `soroban-explorer-client` for Python).

## Source of truth

The OpenAPI document served at `/api/v1/openapi.json` (built from the
`@swagger` blocks in `src/api/**`). `npm run sdk:generate` derives every
generated artefact from it; `npm run sdk:check` fails CI when any committed
artefact differs (drift).

## Semver rules (enforced in CI by `npm run sdk:breaking`)

`packages/client/api-surface.json` is compared with the base branch:

| Change                                                        | Class    | Required bump |
| ------------------------------------------------------------- | -------- | ------------- |
| Operation removed, method/path changed                        | breaking | major         |
| Parameter removed, retyped, made required, enum value removed | breaking | major         |
| New required parameter, request body became required          | breaking | major         |
| New operation, new optional parameter, operation deprecated   | additive | minor         |
| Docs/descriptions only                                        | none     | patch/none    |

Every SDK package version is checked independently.

## Deprecation

1. Mark the operation `deprecated: true` in its `@swagger` block. The
   generated SDKs flag it (`@deprecated` JSDoc, parity matrix ⚠️) — additive,
   minor bump.
2. The API keeps serving it for at least **one major SDK version and 90 days**,
   announcing `Deprecation`/`Sunset` headers (surfaced by the try-it console).
3. Removal ships in the next major.

## Old versions keep working

- The REST API is path-versioned (`/api/v1`); SDKs pin the version in
  `baseUrl`, so publishing a new SDK never changes what an old SDK calls.
- The breaking-change gate guarantees that within a major, every call an older
  SDK can make still exists with compatible parameters.
- `packages/client/test/sdk.test.ts` (“backwards compatibility with the 1.0
  surface”) exercises the 1.0 exports on every CI run.

## Release & provenance

Tag `client-v<version>` (TypeScript) or `python-client-v<version>` (Python).
`.github/workflows/sdk-publish.yml` regenerates, verifies no drift, tests,
builds and publishes with provenance (npm `--provenance`, PyPI trusted
publishing with attestations).
