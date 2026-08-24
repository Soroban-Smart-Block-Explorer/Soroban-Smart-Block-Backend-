# Orphaned Routes Reduction Tracker

Tracks the effort to mount or delete router files in `src/api/` that are
neither mounted (directly or transitively) in `src/api/router.ts` nor
allowlisted in `scripts/validate-routes.ts` (`PENDING_SCHEMA_ROUTERS`).

## Enforcement

- CI runs `npm run validate-routes:ci` (`--max-orphans 15`) on every push/PR.
- CI fails when **orphaned routers > 15** or when **exact route conflicts** exist.
- The validator follows relative imports transitively from `router.ts`, so
  routers composed inside other routers (e.g. the `audit-*` family under
  `audit.ts`, `contract-audit.ts` under `contracts.ts`) count as mounted.
- Budget is defined in `package.json` (`validate-routes:ci`). Lower it as
  orphans are resolved; the target is `0`.
- Run locally: `npm run validate-routes` (strict) or
  `npm run validate-routes:ci` (budget 15).

## Current status (2026-08-24)

| Metric                       | Count  |
| ---------------------------- | ------ |
| Mounted routers              | 69     |
| Pending-schema (allowlisted) | 36     |
| **Orphaned routers**         | **15** |
| Exact route conflicts        | 0      |
| CI budget                    | 15     |

## Orphaned routers — mount or delete

Each entry below must be either mounted in `src/api/router.ts` or deleted.
Update this list and the count above after every change.

| Router file          | Decision | Status |
| -------------------- | -------- | ------ |
| `agents.ts`          |          |        |
| `analytics-query.ts` |          |        |
| `dashboards.ts`      |          |        |
| `flash-loans.ts`     |          |        |
| `forecast.ts`        |          |        |
| `freeze.ts`          |          |        |
| `gas.ts`             |          |        |
| `identity.ts`        |          |        |
| `predict.ts`         |          |        |
| `propagation.ts`     |          |        |
| `ramp.ts`            |          |        |
| `sandwich.ts`        |          |        |
| `sdks.ts`            |          |        |
| `search-routes.ts`   |          |        |
| `token-holders.ts`   |          |        |

## Resolved (2026-08-24)

- **Validator accuracy**: mounted detection now follows imports transitively
  from `router.ts`. Previously it only scanned direct imports, falsely
  flagging 7 sub-mounted routers as orphans (`audit-anchor`, `audit-auditors`,
  `audit-bot-router`, `audit-embed`, `audit-incidents`, `audit-verify`,
  `contract-audit`).
- **Missing import fixed**: `router.ts` called `router.use('/governance',
governanceRouter)` without importing it — a latent crash and a false orphan.
- **Duplicate mounts removed**: `/network` and `/market` were each mounted
  twice in `router.ts`; the duplicates were deleted (exact route conflicts are
  now 0).
- **Stale allowlist cleaned**: 24 entries removed from `PENDING_SCHEMA_ROUTERS`
  for routers that are mounted (audit family, emergency family, `abi`,
  `archive`, and the earlier batch).

## Cleanup sprint checklist

1. [ ] Triage the 15 orphans: mount the ones with implemented handlers, delete
       dead scaffolding (empty routers / stubs).
2. [ ] Re-run `npm run validate-routes:ci` until green (orphans ≤ 15).
3. [ ] Remove any newly-mounted routers from `PENDING_SCHEMA_ROUTERS` if they
       were allowlisted.
4. [ ] Lower `--max-orphans` in `package.json` (15 → 10 → 5 → 3 → 1 → 0) as
       orphans are resolved, keeping CI red until the next target is met.
5. [ ] Update this tracker's status table after each batch.
