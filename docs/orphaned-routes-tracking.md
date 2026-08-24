# Orphaned Routes Reduction Tracker

Tracks the effort to mount or delete router files in `src/api/` that are
neither mounted in `src/api/router.ts` nor allowlisted in
`scripts/validate-routes.ts` (`PENDING_SCHEMA_ROUTERS`).

## Enforcement

- CI runs `npm run validate-routes:ci` (`--max-orphans 5`) on every push/PR.
- CI fails when **orphaned routers > 5** or when **exact route conflicts** exist.
- Budget is defined in `package.json` (`validate-routes:ci`). Lower it as
  orphans are resolved; the target is `0`.
- Run locally: `npm run validate-routes` (strict) or
  `npm run validate-routes:ci` (budget 5).

## Current status (2026-08-24)

| Metric                       | Count  |
| ---------------------------- | ------ |
| Mounted routers              | 53     |
| Pending-schema (allowlisted) | 44     |
| **Orphaned routers**         | **23** |
| Exact route conflicts        | 2      |
| CI budget                    | 5      |

## Orphaned routers — mount or delete

Each entry below must be either mounted in `src/api/router.ts` or deleted.
Update this list and the count above after every change.

| Router file           | Decision | Status |
| --------------------- | -------- | ------ |
| `agents.ts`           |          |        |
| `analytics-query.ts`  |          |        |
| `audit-anchor.ts`     |          |        |
| `audit-auditors.ts`   |          |        |
| `audit-bot-router.ts` |          |        |
| `audit-embed.ts`      |          |        |
| `audit-incidents.ts`  |          |        |
| `audit-verify.ts`     |          |        |
| `contract-audit.ts`   |          |        |
| `dashboards.ts`       |          |        |
| `flash-loans.ts`      |          |        |
| `forecast.ts`         |          |        |
| `freeze.ts`           |          |        |
| `gas.ts`              |          |        |
| `governance.ts`       |          |        |
| `identity.ts`         |          |        |
| `predict.ts`          |          |        |
| `propagation.ts`      |          |        |
| `ramp.ts`             |          |        |
| `sandwich.ts`         |          |        |
| `sdks.ts`             |          |        |
| `search-routes.ts`    |          |        |
| `token-holders.ts`    |          |        |

## Exact route conflicts (shadowed routes)

These duplicate mounts shadow one of the two routes and must be fixed
independently of the orphan budget:

- `/network` mounted twice (`router.use('/network', ...)`)
- `/market` mounted twice (`router.use('/market', ...)`)

## Cleanup sprint checklist

1. [ ] Triage the 23 orphans: mount the ones with implemented handlers, delete
       dead scaffolding (empty routers / stubs).
2. [ ] Fix the 2 exact route conflicts (`/network`, `/market`) by merging the
       duplicate mounts.
3. [ ] Re-run `npm run validate-routes:ci` until green (orphans ≤ 5).
4. [ ] Remove any newly-mounted routers from `PENDING_SCHEMA_ROUTERS` if they
       were allowlisted.
5. [ ] Lower `--max-orphans` in `package.json` (5 → 3 → 1 → 0) as orphans are
       resolved, keeping CI red until the next target is met.
6. [ ] Update this tracker's status table after each batch.
