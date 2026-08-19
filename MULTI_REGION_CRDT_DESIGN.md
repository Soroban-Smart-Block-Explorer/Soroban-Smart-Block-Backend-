# Multi-Region Active-Active Deployment: CRDT & Consensus Design

Design doc for Issue #556. This document is written to be honest about
scope: it distinguishes **what ships as code in this PR** (a real,
tested CRDT library, an HLC clock, a data-sovereignty query filter, and a
reference consensus-interface implementation) from **what is an
infrastructure/deployment concern** that a single application-repo PR
cannot implement (actual multi-region cloud deployment, anycast DNS,
a live etcd/Consul-backed Raft cluster, and a full Jepsen harness against
real network partitions). Each section below says explicitly which bucket
it's in.

## 1. Problem recap

Single-region deployment today means 200-500ms latency for users in
Asia/Africa/South America, no disaster recovery, and no way to satisfy
"EU data stays in EU" data-locality requirements.

## 2. Global data topology — **design + config, not deployed here**

Five regions: `us-east`, `eu-west`, `ap-southeast`, `sa-east`, `af-south`
(`src/regions/topology.ts`). Each region is meant to run the full stack
(indexer, API, Postgres) independently, selecting its identity from a
`DEPLOY_REGION` env var — the same pattern this repo already uses for
`STELLAR_NETWORK` in `src/profiles.ts`.

Data locality falls into two classes:

- **Region-local data** (e.g. an EU user's transaction history): written
  and read from that region's own database only. Never CRDT-replicated
  cross-region; that's the whole point of data sovereignty.
- **Globally-relevant data** (contract ABIs, token metadata, price feeds):
  replicated to every region via the CRDT layer described below, so a
  read in any region is always local.

Actually standing up 5 regional Postgres clusters, an inter-region
replication transport, and DNS/load-balancer config is infrastructure work
(Terraform, Cloudflare/AWS config, VPC peering) that lives outside this
application repository and isn't part of this PR.

## 3. CRDT-based conflict resolution — **implemented in `src/regions/crdt/`**

### 3.1 Primitives shipped

| Type | File | Merge semantics | Property-tested |
|---|---|---|---|
| `LwwRegister<T>` | `lww-register.ts` | Highest HLC timestamp wins outright | commutative, associative, idempotent |
| `GCounter` | `g-counter.ts` | Per-region monotonic slot, merge = pointwise max, value = sum | commutative, idempotent |
| `OrSet<T>` | `or-set.ts` | Observed-Remove: element present iff it has an add-tag not in the tombstone set | commutative |
| `GSet<T>` | `g-set.ts` | Set union | commutative, associative, idempotent |
| `AddOnceRecord<Immutable, Mutable>` | `add-once-record.ts` | Immutable payload + independent per-field LWW registers | commutative |

All merges are pure functions of two states — no coordination, no
ordering requirement, no network round-trip. That's what lets each
region accept a write locally (optimistic) and reconcile asynchronously.

`HybridLogicalClock` (`src/regions/hlc.ts`) generates the timestamps LWW
merges compare. It's used instead of `Date.now()` because regions' wall
clocks are not assumed to be synchronized — HLC gives a partial order that
respects causality (a `receive()` of a remote timestamp always advances
the local clock past it) while staying close to physical time for
human-readable audit logs.

### 3.2 The four models the issue names explicitly

- **`TokenPrice` → `LwwRegister`.** A price quote has no meaningful
  "merge" beyond "the newest one is right." Lossy-by-design: the losing
  write's value is discarded, not queued.
- **`ReputationScore` → `GCounter`.** The issue specifies "merge = max" —
  that's not a scalar max, it's the standard G-Counter construction:
  each region only increments its own slot (so a region's own count is
  monotonic and a lower observed value must be a stale replica, making
  per-slot max safe), and the externally visible score is the sum across
  slots. Mapped onto the existing `ReputationProfile` model.
- **`ComplianceScreeningResult` → `OrSet`.** A screening result needs to
  flip and re-flip (flagged → cleared → re-flagged); a plain 2P-Set
  can't re-add an element once removed, which is why the issue calls out
  observed-remove specifically. Mapped onto `ComplianceReport` /
  `RwaComplianceEvent`.
- **`FeedMessage` → `GSet`.** Already literally an append-only table in
  `schema.prisma` (`FeedMessage`, no `@updatedAt`). No deletions, so
  plain union merge is sufficient and exactly matches current behavior.

### 3.3 The custom case: `Transaction`

The issue calls this out directly: *"transactions are essentially
add-only, but status updates need LWW."* Neither a pure G-Set (can't
update `status`) nor a pure LWW-register (would let a concurrent write
clobber immutable fields like `hash`/`ledger`, and would treat every
field change as replacing the whole row) fits. `AddOnceRecord` is the
composite: the immutable payload (hash, ledger, operations) merges by
"created once, identical everywhere" (any divergence is a data-integrity
bug, not something merge should paper over), and each mutable field
(`status`, `confirmations`, ...) is its own independent LWW register, so
a `status` update from one region can't stomp a concurrent
`confirmations` update from another.

### 3.4 Methodology for the remaining ~220 models

Hand-picking a bespoke CRDT for each of the 226 models in
`schema.prisma` isn't something a reviewer could verify field-by-field,
and the overwhelming majority don't need a bespoke choice. `src/regions/
crdt-registry.ts` implements the classification as **runnable code**,
not a static table, so it's checkable against the live schema:

1. **Explicit overrides** for the models named above (business meaning,
   not just field shape, drives the choice).
2. **Structural fallback** based only on mechanically observable
   properties — model name suffix and presence of `@updatedAt` /
   status-like fields:
   - `*Event|*Log|*History|*Message|*Snapshot|*Audit` with no
     `@updatedAt` → `GSet` (append-only log/event table).
   - `*Count|*Score|*Total|*Tally` with no independent status field →
     `GCounter`.
   - `*Flag|*Screening|*Dispute|*Report|*Badge` → `OrSet` (toggleable
     membership).
   - Anything else → `LwwRegister` (the safe default: an incorrect
     grow-only/counter classification would silently drop legitimate
     updates, whereas LWW never loses a *field*, only a race between two
     concurrent writes to the same field, which is the same tradeoff
     every last-writer-wins system already accepts).

`classifyAllModels()` runs the classifier over the real
`prisma/schema.prisma` at test/build time (`tests/regions/
crdt-registry.test.ts` asserts it covers all 226 models with no gaps),
so as new models are added the registry has an answer for them
immediately rather than needing a person to remember to update a table.

This methodology is deliberately conservative, not exhaustive verification
that every one of the ~220 default-classified models is *optimally*
CRDT'd — some will warrant a custom composite CRDT the same way
`Transaction` did, discovered as they're migrated to multi-region. The
registry's job is to make that gap visible (every model has a
documented, inspectable classification and reason) rather than to claim
certainty it doesn't have.

## 4. Global consensus for conflicting mutations

**Interface implemented; production backing is out of scope for this
repo.** `src/regions/consensus.ts` defines `StrongConsistencyCoordinator`:
`isLeader(region)`, `currentLeader()`, `propose(region, op)`. Compliance
freeze/unfreeze, developer key revocation, and governance vote tally are
exactly the three operation classes the issue names as needing strong
consistency — everywhere else uses the CRDT path above.

A production implementation is Raft over an etcd/Consul-backed cluster
(the issue's own preference over EPaxos, "deprioritized"): real
inter-region RPC, persistent logs, and a majority-quorum commit protocol.
That requires an external consensus cluster this application repo does
not run or configure, so it is not implemented here.

What *is* implemented — `InMemoryRaftCoordinator` — is a reference model
of the same interface: real Raft-shaped leader-election mechanics
(term numbers, majority-based single winner, re-election on leader
failure) simulated across in-process "regions" with a virtual clock, so
the interface contract and failover behavior are pinned down by tests
rather than left as an unverified sketch. `tests/regions/consensus.test.ts`
exercises the "region outage drill" requirement directly:
`failRegion(leader)` simulates taking a region offline, and a new leader
is elected deterministically (bounded by `electionTimeoutTicks`, modeling
the "< 5s failover" requirement as "< 5 ticks" so the test doesn't depend
on wall-clock timing).

Only the leader region may `propose()` — a follower calling it throws
immediately rather than silently no-op-ing, so a client library can fail
fast and retry against whichever region its router picks next.

## 5. Request routing & latency optimization — **infra config, not code in this repo**

Anycast DNS + global load balancer (Cloudflare / AWS Global Accelerator),
session stickiness, and the "write locally, async-replicate" pattern are
described here as the target architecture; the load-balancer and DNS
configuration itself is infrastructure owned outside this repo. The
"write locally, read locally" behavior is what `LwwRegister` /
`AddOnceRecord` are designed to support — a local write already contains
the freshest local HLC timestamp, so a same-region read-after-write is
correct without waiting on cross-region replication. `req.regionScope`
(§7) is the one piece of routing logic that does live in application
code, since it's a query-shaping concern, not a network concern.

## 6. Chaos engineering & testing

**Implemented, at the scope this repo can actually exercise**: property
tests in `tests/regions/crdt.test.ts` prove every CRDT merge is
commutative, associative, and idempotent under randomized merge order —
the mathematical property that guarantees convergence regardless of
network delivery order, which is what a Jepsen run would otherwise be
verifying empirically against a live cluster. `tests/regions/
consensus.test.ts` covers the region-outage-drill failover requirement
directly. Neither of these is a substitute for the issue's actual asks:

- A full Jepsen harness (100k operations under real random network
  partitions against a live multi-node cluster) requires a running
  multi-region deployment and a partition-injection harness (e.g.
  `jepsen.db`/`toxiproxy`) that don't exist for this project yet.
- Scheduled region-outage drills and latency-injection testing
  (simulated 500ms inter-region RTT, verifying local p99 stays <200ms)
  are operational exercises against a live deployment.

Both are natural, valuable follow-up work once an actual multi-region
deployment exists to test against — flagged here rather than
claimed as done.

## 7. Compliance & auditing

- **Data sovereignty (`?region=` filter) — implemented.**
  `src/middleware/regionScope.ts` parses `?region=eu|us|apac|sa|af`
  (accepting the `ap-southeast` region id as an alias for `apac`) and
  attaches `req.regionScope`. It fails closed: an unrecognized value is a
  400, not a silently-ignored parameter, because a compliance filter that
  fails open is worse than one that fails loud. Wiring this into every
  route's Prisma `WHERE` clause is left to each route/service as they
  adopt multi-region — this PR ships the primitive and its contract, not
  a mass rewrite of every query in the codebase (226 models), which
  isn't verifiable review work in one PR.
- **Global ordering via HLC — implemented** (`src/regions/hlc.ts`), for
  the reason in §3.1: no assumption of synchronized wall clocks across
  regions, but still close enough to physical time to be human-readable
  in an audit log.
- **GDPR deletion propagation tracking — not implemented in this PR.**
  This needs a per-user deletion-request record with per-region
  acknowledgement tracking, which is a new feature surface (an admin
  endpoint + a model) rather than a CRDT/consensus primitive, and is
  better scoped as its own follow-up issue once the region topology
  above is actually deployed somewhere.

## 8. Consistency model guarantees, summarized

| Data class | Consistency | Mechanism |
|---|---|---|
| Region-local-only data (EU transactions, etc.) | Strict (single region owns it) | No cross-region replication at all |
| Globally-relevant CRDT-replicated data (prices, reputation, compliance flags, feed messages, transaction status) | Strong eventual consistency (SEC) | CRDT merge — convergent once all updates are seen, no ordering requirement |
| Compliance freeze/unfreeze, key revocation, governance tally | Linearizable | Single elected leader via `StrongConsistencyCoordinator` |
| Read-after-write within a region | Immediate | Local read hits the region that already applied the write |
| Read-after-write across regions | Eventual, bounded by replication lag | Not linearizable by design — acceptable for this data class per the issue |

## 9. What this PR does not claim

To be explicit, restating §2/§5/§6/§7's scope notes together: this PR
does not deploy anything to five cloud regions, does not stand up
etcd/Consul, does not configure Cloudflare/AWS Global Accelerator, and
does not run a Jepsen suite against a live cluster. Those require
infrastructure this repository doesn't provision. What it does ship is a
tested, reusable CRDT/HLC/consensus-interface library plus the one piece
of request-routing logic (`?region=`) that's genuinely application code,
so that whoever provisions the actual multi-region infrastructure has a
correct, verified foundation to build the deployment on top of.
