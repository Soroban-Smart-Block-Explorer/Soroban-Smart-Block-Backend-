# TypeScript SDK — Runbook

## Regenerate after an API change

```bash
npm run sdk:generate          # rewrites generated files + parity matrix
npm run sdk:breaking          # semver check vs origin/main
npm run sdk:build             # compile packages/client
```

Commit the generated files with the API change. CI fails on drift
(`npm run sdk:check`) or on a missing version bump (`npm run sdk:breaking`).

## Debug

| Symptom                                     | Action                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SDK drift` in CI                           | Run `npm run sdk:generate`, commit.                                                                                                                        |
| Operation missing from SDK                  | It is missing from `/api/v1/openapi.json`; stderr `[swagger] Skipped … malformed docs` names the broken route file.                                        |
| Response typed `unknown`                    | The spec has no JSON schema for its 2xx response (or a dangling `$ref`). Add one in the `@swagger` block.                                                  |
| `breaking API changes require a major bump` | Either restore compatibility or bump `packages/client/package.json` (and the Python `pyproject.toml`) to the next major and follow the deprecation policy. |
| Users report retries storms                 | Check `Retry-After` headers from the API; SDK caps waits at `maxRetryDelayMs`.                                                                             |

Enable SDK-side diagnostics in an app:

```ts
new SorobanClient({ logger: console, onRequest: (e) => console.log(e) });
```

## Release

1. Bump `packages/client/package.json` (policy in `docs/sdk/versioning.md`).
2. Tag `client-v<version>` and push the tag.
3. `.github/workflows/sdk-publish.yml` verifies drift, tests, builds and
   publishes with npm provenance (requires the `NPM_TOKEN` secret).

## Recover / roll back a bad release

```bash
npm deprecate @soroban-explorer/client@<bad> "broken release, use <good>"
npm dist-tag add @soroban-explorer/client@<good> latest
```

Never unpublish (breaks lockfiles); ship a patch.
