# ADR-005: CUID vs UUIDv7 for Primary Keys

## Status
Proposed (phased rollout, pending maintainer feedback per phase)

Refs #734

## Context
194 of the 249 models in `prisma/schema.prisma` use `String @id @default(cuid())`.
CUID (25 chars) is not time-sortable, so several high-write, append-only tables
already compensate with composite indexes that pair a monotonic column with
`id` purely to get a stable secondary sort order, for example:

- `Transaction`: `@@index([ledgerSequence, id])`, `@@index([ledgerCloseTime, id])`
- `Event`: `@@index([contractAddress, ledgerSequence, id])`, `@@index([ledgerSequence, id])`

These indexes work, but they exist to route around a property IDs would have
for free if they were time-sortable. UUIDv7 embeds a millisecond timestamp in
its first 48 bits, so records insert roughly in index order, keeping the
primary key's B-tree append-mostly (less page splits/fragmentation than CUID
or UUIDv4, which insert at random points in the key space) and making
`ORDER BY id` a reasonable proxy for insertion order without an extra column.

## Constraints found during evaluation

- **Prisma version.** `@prisma/client` is pinned at `^5.10.0`. Native
  `@default(uuid(7))` generation was only added in Prisma ORM 6.6. Adopting it
  as-is would mean a major-version Prisma bump, which is a dependency change
  I won't make unilaterally in an external PR, per this repo's contribution
  norms it needs a maintainer decision first.
- **Postgres version.** The `db`/`db-testnet` services run `apache/age`
  (Postgres 16-based). Postgres's own built-in `uuidv7()` function ships in
  Postgres 18. Not available here without an image bump.
- **No `pg_uuidv7` extension** is currently installed, so `dbgenerated()`
  can't call a v7 generator at the database layer today either.

Net: there is no zero-dependency, zero-infra-change path to native UUIDv7
generation on this stack right now. The realistic options are:

| Option | Where IDs are generated | New dependency/infra? |
|---|---|---|
| Bump `@prisma/client`/`prisma` to 6.6+, use `@default(uuid(7))` | Prisma query engine | Major version bump (maintainer call) |
| Add `pg_uuidv7` Postgres extension, use `dbgenerated("uuid_generate_v7()")` | Postgres | New extension + migration (maintainer call) |
| Generate in application code (small self-contained helper, no package) at write time | Node process | None |
| Bump Postgres image to 18+, use built-in `uuidv7()` | Postgres | Image/infra bump (maintainer call) |

Application-level generation is the only path that needs no dependency or
infra approval, so it's what phase 2 below implements. It also has a
migration-friendly upside: it works identically for reads/writes throughout
the transition, whichever storage-layer approach (if any) the maintainer
ultimately wants for phase 3+.

## Decision (proposed, phased)

**Phase 1 (this PR): evaluation only.** No schema changes. This document,
plus a first pass at classifying which of the 194 `cuid()` models are
actually high-volume/append-heavy versus low-volume config/reference tables.

**Phase 2 (pending maintainer go-ahead): migrate the clearest high-volume
candidates.** Indexer-driven, high-insert-rate, time-series-shaped tables
where sort-by-id-as-proxy-for-time already matters in practice:

- `Transaction`, `Event` (already carry the `[*, id]` composite-index
  workaround described above)
- `AuditLog`, `WebhookDelivery`, `TokenPriceHistory`, `PoolPrice`, `PoolSwap`

**Phase 3+ (pending maintainer go-ahead, chunked): remaining tables.** The
other ~187 `cuid()` models, in reviewable batches, skipping models where a
natural/composite key is more appropriate than a surrogate one at all (e.g.
`Ledger` already uses `sequence Int @id`, not a CUID).

Each phase is a separate PR/commit set gated on feedback from the previous
one; this ADR's Status line and the phase notes above will be kept current
as phases land or get revised.

## Consequences
- Read/range queries on high-volume tables can eventually drop the
  time-column-plus-id composite indexes in favor of an id-only index once
  IDs themselves sort by insertion time, simplifying schema and lowering
  index-maintenance cost.
- New primary keys grow up to 36 chars instead of 25 (CUID) for migrated
  models; storage/index size per row increases proportionally on those
  tables.
- Existing rows keep their CUIDs unless backfilled; a real data migration
  (not just a schema default change) is required per table taken on in
  phase 2/3, and needs its own rollout plan (dual-write window, backfill,
  cutover) since these are live, high-volume tables.
- Any FK columns referencing a migrated table's `id` need to move in the
  same migration to stay type-consistent.
