# Distributed Sharded Database — Design Doc

> **Status:** Proposal (Phase 1 of #550) — no implementation shipped in this PR.
> **Related issue:** [#550](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/550)

## 1. Summary

Issue #550 asks for horizontal sharding of the Postgres database backing this
explorer, on the grounds that a single node cannot hold the eventual row
counts of the ledger/transaction/event tables. The issue itself requires a
design doc before any implementation ("Design doc required before
implementation") — this document is that Phase 1 deliverable. It:

- Classifies the current 240 Prisma models by write volume and access
  pattern, since only a small subset actually has a scaling problem.
- Evaluates the three shard-key candidates named in the issue
  (`network_id` range, `contract_id` hash, `tenant_id`) against how this
  codebase actually queries and writes data today, and recommends one.
- Explains how the recommendation relates to the range-ownership mechanism
  already shipped for the P2P indexer (`docs/P2P_INDEXER_DESIGN.md`), so the
  two efforts share one range primitive instead of inventing two.
- Designs a cross-shard read path (scatter-gather + merge), a control
  plane, and a rebalancing strategy that build on patterns already present
  in the repo rather than inventing a parallel architecture.
- Calls out where the issue's assumptions (e.g. that 2PC is required, that
  `tenant_id` is a meaningful axis here) don't hold for this specific
  domain, and why.
- Lists the risks and open questions that must be resolved with real
  production metrics before Phase 2 (implementation) starts.

No runtime code changes ship in this PR. Implementation is scoped into the
phased plan in §9, to be opened as separate, reviewable PRs.

## 2. Current architecture (as of this PR)

**Network isolation already exists at the database level, not as a shard
key.** Each Stellar network (`testnet` / `mainnet` / `devnet`) runs against
a fully separate Postgres instance, selected at process startup:

- `src/profiles.ts` — the `PROFILES` registry gives each network its own
  `databaseUrl`, `readReplicaUrl`, RPC endpoint, and cache DSN. Per the
  header comment: *"Each profile is fully self-contained: its own DB
  cluster, read-replica... Active profile is selected by `STELLAR_NETWORK`
  at startup."*
- `docker-compose.yml` runs three independent single-instance Postgres 16
  containers (`db-testnet:5432`, `db-mainnet:5433`, `db-devnet:5434`), each
  with its own volume.
- `src/db.ts` exposes two `PrismaClient`s, `prismaWrite` and `prismaRead`,
  each bound to one datasource — Prisma has no native multi-shard routing,
  so today "routing" means picking one of these two clients.
- `src/db/replicaGateway.ts` already does lag-aware read routing:
  `measureReplicaLag()` compares `IndexerState.lastLedger` between primary
  and replica (5s TTL cache) and `getReadClient()` falls back to the
  primary once lag exceeds `LAG_THRESHOLD_LEDGERS = 2` (fails closed to the
  primary if the health check itself errors). This is the closest existing
  analog to a shard-aware client selector and is the template §6 builds on.

This means **`network_id` is not an available intra-database shard key** —
it's already solved one level up, by giving each network its own cluster.
The scaling problem this issue is actually about is intra-network growth on
`mainnet` (or any single profile) as ledger/transaction/event volume grows
into the billions of rows — that's the scope of everything below.

There is exactly one precedent for partitioning in this codebase today:
`ApiAuditLog` (`prisma/migrations/20260623120000_distributed_rate_limiting/migration.sql`)
is `PARTITION BY LIST ("month")` with composite PK `(id, month)`, seeded
with 12 monthly partitions via a `DO $$ ... FOR VALUES IN` loop. It's
applied to an operational/audit table, not domain data, but it's a working
example of native Postgres declarative partitioning already living in this
repo's migrations, and §5 reuses the same mechanism for the primary
recommendation.

There is no `pg`/pooler package and no pgbouncer in `docker-compose.yml` —
connection pooling today is whatever Prisma's engine does internally.

### 2.1 Relationship to the existing P2P indexer

`docs/P2P_INDEXER_DESIGN.md` already ships a range-ownership mechanism that
overlaps heavily with what this doc needs, and it should be reused rather
than duplicated:

- Ledgers are bucketed into fixed-size ranges (`P2P_RANGE_SIZE`, default
  10,000 — `src/p2p/config.ts`).
- Range ownership is computed by deterministic rendezvous (HRW) hashing
  over a gossiped membership view (`src/p2p/rendezvous.ts`), tracked per
  node in the `IndexerRangeClaim` model, with each of a range's K owners
  independently running the existing single-node indexer
  (`processLedgerRange`) against its own local Postgres.

**What the P2P design solves vs. what this doc solves are different
problems that happen to share a key.** P2P range ownership is about
*write-path redundancy and decentralization* — each of a range's K owners
independently indexes that range into its own complete local database, and
the P2P design's own read path (`GET /p2p/ledger/:seq`,
`resolveLedgerLocation` in `src/p2p/resolve-location.ts`) is a
coordinator-less single-ledger lookup over a libp2p stream protocol, not
the filtered/paginated/aggregated query surface `src/api/*` provides today
(`contractAddress`/`sourceAccount`/`status` filters, cursor pagination,
`groupBy` aggregates). That REST API is still built on one
`prismaRead`/`prismaWrite` pair per network and still assumes a single
database holds the complete dataset — P2P mode doesn't change that. So even
with P2P indexing enabled, the REST API's storage tier still needs the kind
of sharding this doc proposes once total data volume exceeds what one
Postgres instance can hold; P2P redundancy and REST-API storage sharding
are complementary, not substitutes for each other.

Given that, **the shard directory this doc proposes in §6 should be derived
from the same `P2P_RANGE_SIZE` bucketing and `IndexerRangeClaim` range
definitions**, rather than introducing a second, differently-bounded range
concept. Whether a given range's canonical query-serving shard is one of
its P2P index-owners or a separate dedicated shard database is an
implementation choice for Phase 2 (§9); the range boundaries themselves
should not diverge between the two systems.

## 3. Model classification

240 models is not 240 scaling problems. Sampling the schema by write volume
and query shape puts them into three tiers:

**Tier 0 — append-heavy, ledger-ordered event log.** These are the only
tables that plausibly hit billions of rows: `Ledger`, `Transaction`,
`Event`, `ContractState`, `PoolSwap`, `PoolPrice`, `MevEvent`,
`ArbitrageOpportunity`, `ComposedTransaction`, `BridgeTransaction`,
`NftActivity`, `WasmUpgradeHistory`, `ApiAuditLog`. Every one of these
carries a `ledgerSequence`/`ledgerSeq` (or equivalent monotonic) field and
is written once, essentially never updated. `Transaction` and `Event` are
the two the issue is really worried about; `Ledger` is their parent and the
root of the write path (`sequence Int @id`).

**Tier 1 — mutable entity/aggregate state.** `Contract`, `StellarAccount`,
`DexPool`, `NftCollection`, `AccountTrustline`, `AccountSigner`. Keyed by a
natural entity id (contract address, account address), updated in place via
`upsert`, orders of magnitude smaller than Tier 0, and referenced *from*
Tier 0 by FK (`Transaction.contractAddress → Contract.address`,
`Transaction.sourceAccount` is a soft reference to `StellarAccount.address`
with no FK constraint).

**Tier 2 — global reference/operational data.** `IndexerState`, `ApiKey`,
`DevApiKey`, `BillingPlan`, `FeatureDefinition`, `TranslationKey`,
`CronJob`, and the large "config/tooling" surface (sandbox, i18n,
governance-timelock, NL-query models, etc.). Low row count, low write
rate, needed uniformly — these should never be sharded; they either stay on
a single coordinator database or are replicated to every shard verbatim.

This tiering matters because it means the design only needs to solve
sharding for Tier 0, keep Tier 1 small enough to broadcast/replicate rather
than shard, and leave Tier 2 alone entirely.

## 4. Real query and write patterns

Grounding the shard-key choice in how the code actually reads and writes,
not a hypothetical access pattern:

- **Cursor pagination is already the primary read pattern**, keyed on
  `ledgerSequence`. `src/api/transactions.ts` supports both cursor mode
  (`ledgerSequence: { lt: cursor }`, `orderBy: [{ ledgerSequence: 'desc' },
  { id: 'desc' }]`, overfetch-by-one to compute `hasNext`) and an offset
  fallback (`skip`/`take` + `count()`). `Transaction` and `Event` both carry
  compound indexes shaped exactly for this: `@@index([contractAddress,
  ledgerSequence, id])`, `@@index([sourceAccount, ledgerSequence, id])`,
  `@@index([status, ledgerSequence, id])`.
- **Filters are single-entity, not cross-entity joins.** `src/api/events.ts`
  filters by `contractAddress`/`eventType`/`topicSymbol`; `src/api/wallets.ts`
  filters by `sourceAccount`; `src/api/contracts.ts` runs
  `transaction.groupBy({ by: ['functionName'], where: { contractAddress,
  ledgerCloseTime: { gte } } })`. None of the sampled read paths do a
  Prisma-level cross-table `include` between two Tier 0 tables except the
  single-record detail endpoint (`GET /transactions/:hash` pulls its own
  `events` by relation) — there is no evidence of ad-hoc joins across
  Transaction/Event/DexPool/MevEvent that a shard boundary would break.
- **No raw SQL anywhere in `src/`.** Zero uses of `$queryRaw`/`$executeRaw`.
  Every access goes through Prisma's query builder. Any cross-shard executor
  either has to stay within what Prisma's client can do per-shard (and merge
  in application code), or it introduces the first raw-SQL usage in this
  codebase's application code — flagged as a real integration cost in §6,
  not a detail to gloss over.
- **The write path is a single append-ordered stream, not concurrent
  cross-entity writes.** `src/indexer/indexer.ts` processes one ledger at a
  time, upserting `Ledger` → `Contract` → `Transaction` → `Event` for that
  ledger before moving to the next. Backfill (`catchUp()`) already splits a
  ledger range into `WORKERS` non-overlapping chunks
  (`chunkRange(from, to, n)`) and processes them concurrently — i.e. **the
  indexer already shards its own workload by ledger range** for catch-up,
  and (per §2.1) the P2P mode goes further and shards range *ownership*
  across independent nodes the same way. This existing pattern is the
  strongest signal for the shard-key choice below: both the write side and
  the P2P redundancy layer already think in ledger-range partitions.
- **Existing gaps worth fixing regardless of sharding:** `PoolSwap` has no
  index on `poolAddress`, `transactionHash`, or `ledgerCloseTime` despite
  being an append-heavy trade table; `AccountTrustline`/`AccountSigner` have
  no plain index on `accountId` (only as the leading column of a composite
  `@@unique`). These aren't blockers for this doc, but any Tier 0
  reclassification work should fix them under the existing `npm run
  audit:indexes` gate rather than shipping a shard design around
  unindexed tables.

## 5. Shard key: evaluating the issue's three candidates

**`network_id`.** Already the shard key one level up (§2) — separate
clusters per network. There is no `networkId` column on any Tier 0 model to
key on for further sharding (the one exception, `UnifiedTransaction`, has an
explicit `network` field precisely because it's a cross-network merge/dedup
view — the exception proves the rule). Rejected as a further sharding axis;
it's already spent.

**`tenant_id`.** This is a public blockchain explorer indexing a shared
chain, not multi-tenant SaaS over partitioned customer data — there is no
`tenantId` concept anywhere in the 240-model schema. Rejected as
inapplicable to this domain.

**`contract_id` hash.** Colocates a single contract's full history
(`Transaction`, `Event`, `ContractState`, `DexPool` activity) on one shard,
which is attractive for the "give me everything for contract X" query
shape used throughout `src/api/contracts.ts` and `src/api/dex-analytics.ts`.
But it breaks the things §4 shows are actually load-bearing:
  - `Ledger` (the parent of `Transaction`/`Event` via `ledgerSequence`) has
    no contract dimension — it can't be hash-sharded by contract.
  - Every ledger-ordered feed (the cursor pagination in
    `transactions.ts`/`events.ts`, the real-time channels described in
    `DATA_MESH_PLATFORM.md`) needs a globally ledger-ordered scan across
    *all* contracts, which becomes a full scatter-gather across every shard
    on every request under contract-hash sharding.
  - Popular contracts (the issue's own "hotspot" edge case) get worse, not
    better, under hash sharding — a hot contract's entire history lands on
    one shard with no way to split it further without breaking colocation.

**Recommendation: ledger-sequence range sharding**, applied to the Tier 0
tables identified in §3, using Postgres native declarative
`PARTITION BY RANGE` — the same primitive already in production for
`ApiAuditLog`'s `PARTITION BY LIST`, and the same range unit
(`P2P_RANGE_SIZE`) the P2P indexer already uses for range ownership (§2.1).
Reasons this fits the codebase as it exists today, not just in the
abstract:

1. It matches the write path exactly. The indexer writes strictly
   increasing ledger sequences and already partitions its own backfill
   workload by ledger range (`chunkRange`/`catchUp` in `indexer.ts`) — a
   ledger-range shard boundary requires no change to how the indexer thinks
   about its work, only where it connects.
2. It matches the read path exactly. Every hot query path is already
   cursor-paginated on `ledgerSequence` with indexes shaped for exactly
   that access — `(filterField, ledgerSequence, id)`. A shard router that
   resolves `ledgerSequence → shard` composes with that pagination without
   changing the API contract.
3. New shards are pure capacity addition, not data movement. Since
   `ledgerSequence` only increases, growth means opening a new empty range
   shard for future ledgers — no rebalancing of existing data required for
   the common case (see §7).
4. Per-contract "everything for contract X" queries become scatter-gather
   across a *bounded, shrinking* number of shards (only the ranges that
   actually contain activity for that contract, which age-based archival
   already narrows — see `src/archival/archiver.ts`), not a fan-out to
   every shard on every request.
5. It reuses infrastructure this repo already committed to (§2.1) instead
   of introducing a second, incompatible notion of "range" alongside the
   P2P indexer's.

Tier 1 tables (`Contract`, `StellarAccount`, `DexPool`, ...) are small
enough, per §3, to **not be range-partitioned** — they're broadcast/mirrored
to every shard (or centralized on a directory database) so that FK-style
lookups from any shard resolve locally. Tier 2 stays on a single
coordinator database, unsharded.

## 6. Cross-shard read path

Builds directly on `src/db/replicaGateway.ts`'s existing shape (a resolver
function that picks a `PrismaClient`) rather than introducing a new
abstraction:

- **Shard resolver.** A `resolveShard(ledgerSequence): PrismaClient`
  function, structurally the sibling of today's `getReadClient()`, backed by
  a shard-range directory derived from the same range definitions as
  `IndexerRangeClaim` (§2.1) rather than a newly invented table.
- **Single-shard queries stay exactly as they are today.** Any request that
  already has a `ledgerMin`/`ledgerMax`/`cursor` bound (the common case per
  §4) resolves to one shard and runs unmodified through the existing
  Prisma query — no new query-building logic needed for the majority of
  traffic.
- **Unbounded queries scatter-gather and merge in application code**, the
  same way `src/api/wallets.ts` already merges Soroban `Transaction` rows
  with external Horizon API results outside the database: fan the query out
  to the relevant shards' Prisma clients in parallel, then merge-sort the
  results by `(ledgerSequence, id)` in-process — the same ordering the
  existing cursor pagination already assumes, so no client-facing API
  change.
- **No cross-shard join is required for the query shapes found in §4.**
  Every filter observed (`contractAddress`, `sourceAccount`, `status`,
  `eventType`) is a predicate within a single Tier 0 row, not a join
  between two Tier 0 tables on different shards. Where a Tier 0 row
  references Tier 1 (`Transaction.contractAddress → Contract.address`),
  Tier 1 being broadcast to every shard (§5) means that lookup is always
  local — this removes the need for the distributed hash join the issue
  asks for. If a genuine cross-shard join need is found once real query
  logs are available, it should be handled as a broadcast join against the
  (small) Tier 1 side, not a general distributed join executor.
- **2PC is largely unnecessary for writes, which is a correction to the
  issue's assumption.** §4 shows the indexer writes one ledger's
  `Ledger`/`Contract`/`Transaction`/`Event` rows as a unit, and ledger
  ranges map to single shards by construction — the natural write
  transaction never spans a shard boundary. The only place a genuine
  cross-shard write could occur is a backfill/reindex job that straddles a
  shard boundary mid-ledger, which is avoidable by aligning shard
  boundaries on the same range boundaries the indexer and P2P layer already
  compute. Where a cross-shard write is unavoidable (e.g. correcting a
  `WasmUpgradeHistory` record after a shard split), the recommendation is a
  saga/outbox pattern (write the intent, apply per-shard, mark complete) —
  the same shape as the P2P design's own `ReindexTask` queue (§2.1) — not
  true distributed 2PC. Prisma 5.x (the major version pinned in
  `package.json`) has no 2PC/XA primitive, and introducing one would mean
  bypassing Prisma with raw SQL in application code for the first time in
  this codebase (§4), which is a cost worth naming explicitly rather than
  waving away.

## 7. Live rebalancing

Because the shard key is a ledger-sequence **range** and writes are
strictly append-ordered, rebalancing splits into two very different cases:

- **Growth (the common case): add a new shard for future ledgers.** No data
  movement — the new shard starts empty and the directory's range table
  gets a new upper-open entry. This is the dominant operation and requires
  no downtime and no replication machinery.
- **Splitting an existing range (the rare case), e.g. one shard grew larger
  than expected before a new boundary was cut.** Use Postgres logical
  replication to stream the range being split to a new shard while the old
  shard keeps serving reads; once caught up, flip the directory's range
  boundary atomically (single-row update on the Tier 2 directory table),
  then decommission the now-unreferenced rows on the origin shard. Because
  Tier 0 rows are immutable once written (§3), there's no concurrent-write
  conflict to resolve during the copy — this is materially simpler than
  rebalancing a hash-sharded, mutable-row system, which is the case the
  issue's "100GB rebalance with <1s write unavailability" target seems to
  assume.

## 8. Control plane and edge cases

- **CLI.** A `scripts/shard-admin.ts`, following the existing convention of
  `scripts/audit-indexes.ts` and `scripts/validate-prisma-references.ts` —
  list shards and their ledger ranges, show per-shard row/size estimates,
  trigger a range split.
- **API.** Internal `/api/v1/admin/shards` endpoints in `src/api/`, mirroring
  existing route conventions (`asyncHandler`, zod-validated query params).
- **Metrics.** `src/metrics.ts` and `src/middleware/metricsMiddleware.ts`
  already exist — extend them with per-shard labels (connection pool
  saturation, query latency, replication lag reusing the
  `measureReplicaLag` pattern) rather than standing up a parallel metrics
  path.
- **Hotspot handling.** Under ledger-range sharding the head shard (most
  recent ledgers) is *always* the hottest by construction — this is a
  different shape than the issue's "popular contract" framing. Mitigate
  with read replicas on the head shard specifically (reusing
  `replicaGateway.ts`), not by adding more shards.
- **Partial results on shard failure.** Scatter-gather queries (§6) return
  what succeeded plus per-shard health metadata; the API surfaces which
  ledger ranges are missing so clients relying on the existing cursor
  contract can detect and retry a gap rather than silently getting an
  incomplete page.
- **Per-shard backup/restore.** Each shard is an ordinary Postgres
  database — standard `pg_dump`/`pg_basebackup` per shard, independent of
  the others. This is simpler than backing up one enormous single-node
  database, not harder.
- **Zero-downtime single-node → sharded migration.** Pin the indexer to
  keep writing the existing single-node database as the head shard, backfill
  historical ledger ranges into new range shards via logical replication
  from a snapshot (same mechanism as §7's split case), and cut the read
  path over range-by-range as each completes — the existing single database
  never stops serving during the migration.

## 9. Phased implementation plan

This PR is Phase 1. Each later phase is scoped to be its own reviewable PR:

1. **(this PR) Design doc** — shard key, cross-shard read path, control
   plane shape, rebalancing strategy, open risks.
2. **Shard directory + resolver** behind a feature flag, defaulting to the
   current single-database behavior (`resolveShard` always returns
   `prismaWrite`/`prismaRead` until a second shard exists), sourcing its
   range definitions from the same place `IndexerRangeClaim` does (§2.1) so
   the two systems never disagree about where a boundary falls.
3. **Second shard, ledger-range partitioned**, exercised by backfill/replay
   traffic only, cross-checked against the existing single-node database
   for correctness before any production read traffic is routed to it.
4. **Cross-shard scatter-gather read path** for the small set of endpoints
   that issue genuinely unbounded queries, plus partial-result handling.
5. **Control plane** (CLI, admin API, metrics) and **rebalancing** (range
   splits via logical replication), validated with the chaos scenarios the
   issue lists (shard partition, slow shard, mid-split failure) before
   being called production-ready — following the same "verify by actually
   running it" bar `docs/P2P_INDEXER_DESIGN.md` §7's chaos scripts set.

## 10. Open questions and risks

- **No production row-count or query-log data yet.** Every conclusion above
  is derived from schema shape and code paths, not measured query
  frequency/latency. Before committing to specific shard boundaries or a
  shard count, Phase 2 needs real `pg_stat_statements`/slow-query data from
  a running `mainnet` deployment.
- **Prisma has no native multi-shard support.** Every cross-shard operation
  in this design is application-code orchestration over multiple
  `PrismaClient` instances, not a Prisma feature — this is more
  hand-rolled plumbing than the issue's framing ("Prisma integration at low
  level") might suggest, and is a real maintenance cost.
- **First introduction of raw SQL in application code.** The
  `PARTITION BY RANGE` DDL itself is contained to migrations (Prisma
  migrations already support raw SQL there, as the `ApiAuditLog` precedent
  shows), but any future cross-shard query optimization done outside plain
  Prisma calls would be new territory for `src/`.
- **`ContractState` and `AccountTrustline`/`AccountSigner` don't have a
  ledger-sequence field usable for range sharding the same way
  `Transaction`/`Event` do** (`ContractState` has `liveUntilLedgerSeq` but
  is keyed by `[contractAddress, ledgerKey]`) — these need a follow-up
  analysis in Phase 2 rather than being assumed to fit the same range-shard
  model as Tier 0's transaction/event tables.
- **P2P range-ownership and query-serving shard assignment can diverge** if
  Phase 2 doesn't share the same directory (§2.1) — e.g. a range's P2P
  index-owners and its designated read-serving shard could disagree about
  boundaries if they're allowed to evolve independently. The phased plan
  addresses this by sourcing both from one range definition, but it's worth
  stating as a risk rather than assuming it away.
- **The issue's acceptance target (cross-shard p99 < 500ms, <1s write
  unavailability on a 100GB rebalance)** is not validated by this doc — it's
  a target for Phase 3–5 to measure against once shards actually exist,
  not a claim this design proves today.
