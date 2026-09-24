# npm audit Exceptions Tracker

Tracks the `.auditignore` exceptions accepted by `scripts/audit-check.js` so
`npm audit --audit-level=high` findings never go silently unenforced again
(#897 — the Security job used to run `npm audit ... || true`).

## Enforcement

- CI runs `npm run audit:ci` (full dependency tree) in the Security job.
- The Dockerfile builder stage runs `node scripts/audit-check.js` after
  `npm ci`; the runtime stage runs `node scripts/audit-check.js --omit=dev`
  after its production-only install — both mirror `npm audit
  --audit-level=high`.
- `scripts/audit-check.js` fails the build on **any** high/critical finding
  whose package is not listed in `.auditignore`, and fails outright if a
  listed exception's `reviewBy` date has passed.
- Run locally: `npm run audit:ci` (or `npm run audit:ci -- --omit=dev` to
  mirror the runtime stage).

## Current status (2026-08-28)

| Metric                              | Count |
| ------------------------------------ | ----- |
| High/critical findings               | 6     |
| Fixed directly (this change)         | 1     |
| Documented exceptions (`.auditignore`) | 5   |
| Unexplained (would fail CI)          | 0     |

## Fixed directly

| Package             | Was      | Now       | Notes                                                             |
| -------------------- | -------- | --------- | ------------------------------------------------------------------ |
| `fast-xml-parser`     | ≤5.6.0 (critical, via `@aws-sdk/client-s3`) | fixed | `@aws-sdk/client-s3` bumped `3.600.0` → `3.1121.0` (non-major, `npm audit fix`-reported range) |
| `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `@smithy/*` | various (high/moderate) | fixed | `npm audit fix` (non-breaking) |

## Open exceptions — fix or re-review by `reviewBy`

| Package                                          | Severity | Advisory                | Blocked on                                   | reviewBy   |
| ------------------------------------------------- | -------- | ------------------------ | --------------------------------------------- | ---------- |
| `@libp2p/kad-dht`                                  | high     | GHSA-32mq-hpph-xfvr       | `@libp2p/interface` v2 → v3 across the whole libp2p dependency tree (10+ packages) | 2026-11-30 |
| `vitest`, `@vitest/coverage-v8`, `@vitest/ui`, `vite` | critical/high | GHSA-5xrq-8626-4rwp and related | vitest v1 → v4 major migration (config, coverage, reporters) | 2026-11-30 |

Each row above must be either fixed (dependency bumped, entry removed from
`.auditignore` and this table) or have its `reviewBy` date pushed out again
in `.auditignore` after confirming the exception still applies — an expired
date fails CI by design.
