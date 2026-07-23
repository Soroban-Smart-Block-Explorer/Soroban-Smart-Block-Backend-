# Distributed P2P Indexer Network — Design Doc

## 0. Problem

The indexer was a single point of failure: one process indexes all ledgers
for a network, with no redundancy, no load distribution, and no way to
verify correctness short of a full re-index from genesis. This document
describes the P2P indexer network built to address that, and is the
"design doc with PBFT vs RAFT analysis" deliverable required by the
originating spec.

Scope note: this is a large feature (P2P overlay, distributed work
assignment, verification/slashing, coordinator-less queries, an incentive
layer) implemented in a single pass. The load-bearing pieces — DHT peer
discovery, gossip propagation, rendezvous-hash range ownership,
challenge-response verification, query forwarding with graceful
degradation, and the CJS/ESM interop boundary — are real, working code,
verified by compiling and running against the actual installed dependency
versions (see §5 and §9). Some pieces are intentionally stubbed per the
original requirements (staking) or simplified for a first pass (see §9).

## 1. Architecture per requirement area

### 1.1 P2P overlay (per-network swarm)

One libp2p node per indexer process, keyed by `STELLAR_NETWORK`. Each of
`testnet` / `mainnet` / `devnet` gets a fully isolated swarm: every gossip
topic and stream protocol is namespaced by network —
`/soroban-indexer/${network}/gossip/ledger-headers/1.0.0`,
`/soroban-indexer/${network}/challenge/1.0.0`, etc. (`src/p2p/config.ts`'s
`protocolId`/`topicId`). Even if a testnet and mainnet node happen to dial
each other at the transport level, libp2p's protocol negotiation
(multistream-select) fails to agree on any shared protocol and the
connection is simply useless to both sides — no extra guard code needed.
Trust/reputation state is additionally isolated because each network runs
against its own physical Postgres database, exactly as today.

- **Transport**: `@libp2p/tcp` (server-to-server), plus
  `@libp2p/circuit-relay-v2` (relay client always; relay *server* role only
  for nodes with `P2P_IS_RELAY_SERVER=true`, keeping the "everyone relays"
  surface area small) and `@libp2p/dcutr` for hole-punching once a relayed
  connection exists.
- **Encryption / muxing**: `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`.
- **Discovery**: `@libp2p/kad-dht` (Kademlia DHT, `clientMode: false`) plus
  `@libp2p/bootstrap` (static seed list via `P2P_BOOTSTRAP_PEERS`) and
  optionally `@libp2p/mdns` (LAN-only, used by the local docker-compose
  harness — see §7 — to sidestep needing to know the seed's PeerId ahead of
  time).
- **Identity**: persistent Ed25519 keypair, generated once and written to
  `P2P_IDENTITY_PATH` (default `./data/p2p/${network}/identity.key`,
  volume-mounted in Docker), so a restarted node keeps its PeerId — needed
  for reputation continuity and for rendezvous hashing (§1.2) to not treat
  every restart as a brand-new node.
- **Gossip**: `@chainsafe/libp2p-gossipsub`, three topics per network:
  `ledger-headers`, `membership` (heartbeats), `peer-reputation`.

Implementation: `src/p2p/esm/node-factory.mts`.

### 1.2 Distributed indexing protocol — range ownership & verification

**Range ownership is computed by deterministic rendezvous (HRW) hashing
over a gossiped membership view — not by RAFT or PBFT.** Full
justification in §2.

- Ledgers are bucketed into fixed-size ranges (`P2P_RANGE_SIZE`, default
  10,000). `src/p2p/range.ts`.
- Every node maintains a local, eventually-consistent **membership view**:
  the set of currently-alive PeerIds, built from gossiped heartbeats
  (`membership` topic) with a liveness TTL (`P2P_HEARTBEAT_INTERVAL_MS` ×
  `P2P_HEARTBEAT_MISSED_BEFORE_STALE`, default 30s). `src/p2p/membership-view.ts`.
- **Rendezvous hashing**: for a `rangeId`, each node computes
  `score(peerId, rangeId) = SHA-256(peerId | rangeId)` for every peer in its
  active view, sorts descending, and takes the top-K as that range's owners
  (K = `P2P_REPLICATION_FACTOR`, default 3). `src/p2p/rendezvous.ts`. This
  is a pure function — O(active peers), zero network round-trips, and has
  the *minimal-disruption* property: a peer joining/leaving only reassigns
  the ~K/N fraction of ranges where it enters/leaves the top-K (verified in
  `tests/p2p/rendezvous.test.ts`).
- Each of a range's K owners independently runs the **existing**
  single-node indexing logic (`processLedgerRange` in
  `src/indexer/indexer.ts`) against its own local Postgres — K=3 replication
  is simply "three separate nodes each do normal indexing for the same
  range," not a new replicated-write-path.
- **Challenge-response verification**: periodically (`P2P_CHALLENGE_INTERVAL_MS`,
  jittered), a node picks a random ledger it owns and a random co-owner,
  and asks it (via the `/challenge/1.0.0` stream protocol) to independently
  compute `indexHash = SHA256(canonical_json(ledgerHash, sorted tx hashes,
  sorted event ids, sorted decoded-event-payload hashes))`
  (`src/p2p/index-hash.ts`). Equal hashes → both sides' `challengesPassed`
  increments. Unequal → a **third** co-owner is asked as a tiebreaker
  (majority-of-3 rather than assuming either original side is at fault);
  the loser's `challengesFailed` increments, a `VerificationChallenge` audit
  row is written, and a `ReindexTask` is enqueued.
  `src/p2p/challenge-scheduler.ts`.

### 1.3 Coordinator-less query

`GET /p2p/ledger/:seq` (`src/index.ts`) → `resolveLedgerLocation`
(`src/p2p/resolve-location.ts`):

1. Check the local DB first (free, no network hop).
2. If absent, compute the range's owners from the local membership view and
   try each live owner via the `/query/1.0.0` stream protocol.
3. If every owner is unreachable, index the ledger **on-the-fly**
   (`indexSingleLedger` in `src/indexer/indexer.ts`, called with
   `{force: true}` to bypass the ownership gate) — this is the graceful
   degradation path, and it doubles as ad hoc self-healing.

Distributed query cache: not a new protocol, just the existing Redis/memory
LRU (`src/cache.ts`) namespaced `p2p:${network}:query:${seq}`
(`src/p2p/distributed-cache.ts`). Read-repair: when a forwarded response's
`indexHash` disagrees with an already-cached value, a `ReindexTask` is
enqueued via the same mechanism challenge-mismatches use — no separate
repair protocol.

### 1.4 Incentive layer

- **Reputation** (`src/p2p/reputation-scorer.ts`): `100 * (0.5·passRate +
  0.3·uptimeRatio + 0.2·latencyScore)`, computed **locally per node** from
  its own challenge/heartbeat/ping history — deliberately *not* a globally
  agreed value (see §2 for why that doesn't need consensus). Gossiped
  opinions from other peers (`peer-reputation` topic) are blended in with a
  small decay weight (`blendReportedScore`, default 10%) so no single
  reporter can unilaterally tank a peer's score.
- **Staking hook** (`src/p2p/stake-provider.ts`): a `StakeProvider`
  interface (`getStake`, `slash`, `isStakingEnabled`) with a
  `NullStakeProvider` v1 implementation (stake always 0, slash is a
  logged no-op) — matches the requirement that staking itself is out of
  scope for v1 but the extension point must exist.
- **Dashboard**: `GET /p2p/status` (`src/p2p/status-snapshot.ts`) returns
  the peer table, range-ownership table, and recent challenge results;
  `/health`'s `dependencies.p2p` reports connected-peer-count-based health.

## 2. PBFT vs RAFT — recommendation

**Neither RAFT nor PBFT is used for range assignment.** Assignment uses
deterministic rendezvous hashing (§1.2) over a gossiped membership view.
Byzantine fault *detection* uses challenge-response with a majority-of-3
tiebreak, not a BFT consensus protocol. This is a deliberate choice, not an
open question — argued against each acceptance criterion:

| Criterion | RAFT | PBFT | Rendezvous + challenge-response (chosen) |
|---|---|---|---|
| **<200ms query overhead, 10+ nodes** | Leader + majority commit per assignment change; even if assignment isn't on the query hot path, staleness during a leader election forces either blocking or "possibly stale" reads anyway | O(n²) message complexity per agreed operation (pre-prepare/prepare/commit all-to-all) — wildly disproportionate for "who owns this range" | O(1) local computation, zero round-trips |
| **New node claims a range within 5 min** | Must be added to cluster config (itself a log entry requiring consensus; RAFT membership changes are notoriously fiddly to get safely right), then wait for reassignment entries to commit | Same class of problem, worse constant factor | The moment a heartbeat propagates via gossip (single-digit seconds at realistic N), every node's local view updates and the new peer is *already* the computed owner — no explicit "claim" transaction. Dominant cost is I/O (syncing from RPC), identical to single-node `catchUp` |
| **Malicious node detected within 3 ledger closes** | N/A — RAFT assumes crash faults only, not Byzantine | Byzantine-tolerant, but for the *wrong* problem: PBFT achieves agreement on a *single global operation sequence* despite up to *f* Byzantine nodes out of 3*f*+1. Detecting "this specific peer returned a wrong hash for this specific ledger" doesn't need global total order — it needs one extra RPC and a hash comparison | Challenge-response gives this directly: one extra request-response round + a majority-of-3 vote when the first two disagree |
| **33% of nodes offline** | Needs a live majority (`⌊(n-1)/2⌋` tolerance) for leader election and log commitment — 33% offline sits right at RAFT's edge, and any election churn during that window stalls all writes to the range-assignment log | Needs *n* ≥ 3*f*+1 (<33% Byzantine, not just offline) — also at the edge, provisioned for the harder Byzantine case at a much higher message cost | No majority requirement for assignment at all: any node with a locally-converged view keeps computing valid ownership. A given range is only unavailable if all 3 of *its specific* replica-set nodes are down simultaneously — a far weaker condition than "global majority alive" |

**Where a real consensus-shaped primitive is actually used**: the
majority-of-3 tiebreak in challenge-response is effectively a tiny,
per-range-per-ledger Byzantine-tolerant vote — but it's scoped to one
ledger's three replicas, never a global total-order log, so it stays cheap.
If K were raised well above 3 for higher assurance, this generalizes to a
`⌈(K+1)/2⌉`-quorum vote without needing PBFT's full view-change/primary-election
machinery, since there's no cross-ledger ordering requirement.

## 3. CJS/ESM interop

The current libp2p ecosystem is ESM-only; this project is CommonJS
(`tsconfig.json`'s `module: commonjs`). Resolution:

- Every file that imports `libp2p`/`@libp2p/*`/`@chainsafe/libp2p-*` lives
  under `src/p2p/esm/` with a **`.mts` extension**, compiled by a separate
  `tsconfig.p2p.json` (`module`/`moduleResolution: NodeNext`, `outDir:
  dist-esm`) into `.mjs` — Node treats `.mjs` as ESM regardless of the root
  `package.json`'s CJS default, so no nested `package.json` trick is needed.
- `src/p2p/index.ts` (plain CJS) is the only file allowed to reach into
  `esm/`, and does so via `dynamicImport(path.join(__dirname, ...,
  'dist-esm', 'node-factory.mjs'))`.
- **The critical detail, verified empirically, not assumed**: TypeScript
  rewrites `import(x)` to a `require(x)`-based shim under `module: commonjs`
  *even when `x` is a runtime value, not a string literal* — the initial
  implementation used a computed variable expecting that to be safe, and
  inspecting the compiled output showed TS had produced
  `Promise.resolve().then(() => require(x))` anyway, which throws
  `ERR_REQUIRE_ESM` against a genuine ESM target. The fix, also verified by
  inspecting compiled output and running it: construct the `import()` call
  inside `new Function('specifier', 'return import(specifier)')`. TypeScript
  cannot see into a `Function` constructor's string body, so it cannot
  rewrite it — this is a real dynamic `import()` at runtime. See
  `src/p2p/index.ts`'s `dynamicImport`.
- Everything CJS code touches from the ESM layer crosses via plain
  callbacks passed into `createP2pNode(opts)` (gossip/stream callbacks) and
  plain data returned from the handle (`peerId: string`, not a `PeerId`
  object) — no ESM-only type ever needs to type-check inside CJS code.
- `Dockerfile`'s final stage copies both `dist/` and `dist-esm/`;
  `package.json`'s `build` script runs `tsc && tsc -p tsconfig.p2p.json`.

## 4. Data model

Four new Prisma models (`prisma/schema.prisma`), all network-scoped:

- **`PeerNode`** — per-peer registry: id (PeerId), network, multiaddrs,
  timestamps, `reputationScore`, `challengesPassed`/`challengesFailed`,
  `latencyMsEwma`, `stakeAmount` (unused until `StakeProvider` has a real
  implementation), `isBootstrapPeer`.
- **`IndexerRangeClaim`** — one row per ledger range: bounds, the
  last-computed `ownerPeerIds` (advisory cache, not authoritative — always
  recomputable from the current membership view), and `lastIndexedLedger`
  (this node's own per-range cursor, replacing the singleton `IndexerState`
  row when `P2P_ENABLED=true`).
- **`VerificationChallenge`** — audit trail of every challenge-response
  round (hashes, tiebreaker, result) — what the chaos harness (§7) polls to
  prove malicious-node detection.
- **`ReindexTask`** — queue of ledgers flagged by a challenge mismatch or
  query read-repair.

## 5. Dependency versions (important — read before bumping)

The current libp2p npm ecosystem is mid-migration: `libp2p@3.x` and its
official companion packages (`@libp2p/kad-dht`, `@libp2p/tcp`,
`@libp2p/identify`, `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`,
`@libp2p/peer-id`, `@libp2p/crypto`, ...) were bumped together to depend on
`@libp2p/interface@^3.x`, but `@chainsafe/libp2p-gossipsub` (a separately
maintained package) has **not** — its latest published version
(`14.1.2`) still requires `@libp2p/interface@^2.0.0`. Installing "latest"
of everything produces a dual-package-hazard type-checking failure (two
incompatible copies of `@libp2p/interface` in the tree) that only surfaces
at compile time, not at `npm install` time.

This was diagnosed empirically (not guessed) by checking each package's
declared `@libp2p/interface` range and its actual publish timestamp, and
resolved by pinning the **entire** libp2p-adjacent dependency set to the
last mutually-compatible `@libp2p/interface@2.11.0`-generation snapshot
(published 2025-08-20, the day before the v3 wave):
`libp2p@2.10.0`, `@libp2p/interface@2.11.0`, `@libp2p/kad-dht@15.1.11`,
`@libp2p/tcp@10.1.19`, `@libp2p/identify@3.0.39`,
`@libp2p/circuit-relay-v2@3.2.24`, `@libp2p/dcutr@2.0.38`,
`@libp2p/bootstrap@11.0.47`, `@libp2p/mdns@11.0.47`,
`@libp2p/crypto@5.1.8`, `@libp2p/peer-id@5.1.9`, `@libp2p/logger@5.2.0`,
`@libp2p/ping@2.0.37`, `@multiformats/multiaddr@12.4.4`,
`@multiformats/dns@1.0.9` (exact-pinned — its own *latest* silently
reintroduced an `@libp2p/interface@^3.x` dependency in a patch release),
`@chainsafe/libp2p-noise@16.1.5`, `@chainsafe/libp2p-yamux@7.0.4`,
`@chainsafe/libp2p-gossipsub@14.1.2`, `it-pipe@3.0.1`,
`it-length-prefixed@10.0.1`, `uint8arrays@5.1.0`. All versions are
**exact-pinned** (no `^`), plus an `overrides.@libp2p/interface: "2.11.0"`
in `package.json`, because several packages in this ecosystem have shipped
patch releases that silently bump a peer's major version requirement —
caret ranges are not safe here. **Before bumping any of these, re-verify
the whole set is mutually compatible** (check each candidate's declared
`@libp2p/interface`/`@multiformats/multiaddr`/`uint8arrays` range, not just
its own latest version number) — see `git log` on `package.json` for the
verification method used.

`@libp2p/interface@2.11.0`'s `Stream` type is a classic `Duplex<source,
sink>` (not the newer `MessageStream`/`.send()` API that v3 introduces),
which is why `src/p2p/esm/protocols/streams.mts` uses `it-pipe` +
`it-length-prefixed` for the challenge/query request-response protocols
rather than the simpler async-iterator pattern — this was also discovered
by inspecting the installed `.d.ts` files after the version pin, not
assumed from general libp2p familiarity.

## 6. Wire protocols

- **`gossip/ledger-headers`**: `{v, type:'ledger_header', network, ledgerSeq,
  hash, previousLedgerHash, closeTimeUnix, publisherPeerId}` — existence/liveness
  signal only; ledger content always comes from RPC, never trusted from gossip.
- **`gossip/membership`**: `{v, type:'heartbeat', network, peerId, multiaddrs,
  ledgerCursor, timestamp}` — every `P2P_HEARTBEAT_INTERVAL_MS` (default 10s).
- **`gossip/peer-reputation`**: `{v, type:'reputation_update', network,
  aboutPeerId, reputationScore, challengesPassed, challengesFailed,
  latencyMsEwma, reporterPeerId}` — every `P2P_REPUTATION_GOSSIP_INTERVAL_MS`
  (default 5 min).
- **`/challenge/1.0.0`** (stream): request `{v, type:'challenge_request',
  ledgerSeq, nonce, challengerPeerId}` → response `{v,
  type:'challenge_response', ledgerSeq, nonce, indexHash, computedAt,
  challengedPeerId}`.
- **`/query/1.0.0`** (stream): request `{v, type:'query_ledger', ledgerSeq,
  includeEvents}` → response `{v, type:'query_ledger_response', found,
  ledger?, transactions?, events?, indexHash, servedByPeerId}`.

## 7. Verification / testing

- **Unit tests** (`tests/p2p/*.test.ts`, 31 tests, all passing): pure-function
  coverage of rendezvous hashing (determinism, minimal-disruption property,
  K-clamping, dedup), index-hash canonicalization (order-independence,
  single-byte-difference detection — the exact property the malicious-node
  chaos test relies on), membership TTL eviction, range bucketing, and the
  reputation formula.
- **Local N-node harness**: `docker-compose.yml`'s `p2p` profile runs a
  3-node swarm (`indexer-testnet-p2p-seed/peer1/peer2`), each its own
  Postgres, each running the **combined** `dist/index.js` process (not the
  headless indexer) so every node exposes `/health`, `/p2p/status`, and
  `/p2p/ledger/:seq` over HTTP on ports 3010-3012. Scale to 10+ nodes via
  `ts-node scripts/gen-p2p-compose.ts 10 > docker-compose.p2p.generated.yml`
  then `docker compose -f docker-compose.yml -f docker-compose.p2p.generated.yml --profile p2p up -d`.
- **`scripts/chaos/kill-random-nodes.ts`**: stops ~33% of nodes, waits for
  membership to converge, then confirms a survivor still serves a
  previously-known ledger range (via a local replica or on-the-fly
  indexing) — the 33%-offline acceptance criterion.
- **`scripts/chaos/inject-bad-hash.ts`**: restarts one node with
  `P2P_TEST_CORRUPT_HASH_RANGE` set (flips one hex character of its
  computed index hash for a ledger range — see
  `resolve-location.ts`'s `maybeCorruptForTesting`, gated so it can never
  fire outside an explicit test env var), then polls observer nodes'
  `/p2p/status` until a `mismatch`/`tiebreak_resolved` entry appears —
  asserting the 3-ledger-close detection bound. Note: hitting that bound
  literally requires `P2P_CHALLENGE_INTERVAL_MS` on the order of one ledger
  close (~5s), not the 60s production default; the compose profile sets it
  to 15s for the test harness.
- **`scripts/chaos/query-latency-bench.ts`**: measures p50/p95/max latency
  of `/p2p/ledger/:seq` for ranges the queried node doesn't own locally
  (forcing the forward path) — the <200ms acceptance criterion, with the
  explicit caveat that this measures the docker-compose bridge network, not
  a WAN deployment.
- **Regression safety**: with `P2P_ENABLED` unset (the default), every
  P2P-aware function (`amIResponsibleFor`, `getLastIndexedLedger`, etc.)
  takes its original, unmodified code path — this is an additive,
  opt-in feature, not a rewrite of single-node behavior.

## 8. Rollout

- Default `docker-compose.yml` services (`indexer-testnet/mainnet/devnet`,
  `api-testnet/mainnet/devnet`) are **unchanged** — P2P is off unless
  `P2P_ENABLED=true` is set, zero risk to existing deployments.
- New env vars (per the existing `TESTNET_`/`MAINNET_`/`DEVNET_` profile
  convention, but network-agnostic since `STELLAR_NETWORK` already selects
  the active profile): `P2P_ENABLED`, `P2P_LISTEN_ADDR`,
  `P2P_ANNOUNCE_ADDR`, `P2P_BOOTSTRAP_PEERS`, `P2P_RANGE_SIZE`,
  `P2P_REPLICATION_FACTOR`, `P2P_CHALLENGE_INTERVAL_MS`,
  `P2P_HEARTBEAT_INTERVAL_MS`, `P2P_IDENTITY_PATH`, `P2P_MDNS_ENABLED`,
  `P2P_IS_RELAY_SERVER`.
- Real (non-compose) deployments need an operator-maintained static
  bootstrap list (`P2P_BOOTSTRAP_PEERS`), analogous to Bitcoin/IPFS
  DNS-seed lists — building actual DNS-seed infrastructure is out of scope
  for this pass.
- `prisma migrate deploy` picks up the four new models identically across
  all three network databases, same as any other schema change.

## 9. Risks, limitations, and what's stubbed

- **NAT traversal cannot be meaningfully verified in this environment.**
  `@libp2p/dcutr` (hole-punching) and `circuit-relay-v2` are wired per the
  library's documented API and type-check/build correctly, but a
  single-Docker-host test harness has no real NAT/multi-network topology to
  exercise — local testing only proves the direct-TCP and
  circuit-relay-fallback paths, not the dcutr upgrade path itself.
- **Explicitly stubbed, matching the original requirements**: token staking
  (`NullStakeProvider` only — staking was called out as out-of-scope for
  v1). Persisted/DB-backed query cache — the existing Redis/memory LRU is
  reused instead; a `QueryCacheEntry` Prisma model was considered and
  dropped as scope creep. Relay *server* role is opt-in per node
  (`P2P_IS_RELAY_SERVER`) rather than every peer relaying by default.
  DNS-seed peer discovery beyond a static bootstrap list.
- **Range-boundary edge case**: `processLedgerRange`'s per-ledger
  responsibility check (`amIResponsibleFor`) can skip ledgers mid-batch if
  a batch happens to straddle a range boundary with different owners. Since
  `P2P_RANGE_SIZE` (10,000) is two orders of magnitude larger than
  `INDEXER_BATCH_SIZE` (100), this is rare in practice; the existing reorg
  check degrades gracefully (no-ops) rather than crashing when the previous
  ledger's row is absent because a different range owns it.
  Non-P2P-specific fields (`§2 of the events-fetch step`) still assume the
  whole batch is contiguous — a known, accepted v1 simplification.
- **Operational cost**: K=3 independent replicas each doing their own RPC
  fetches for the same ledger range means ~3× the upstream Soroban
  RPC/Horizon load versus today's single indexer, for the same steady-state
  throughput — worth watching against upstream rate limits, particularly on
  mainnet.
- **Numbers are "proven in the reference harness," not WAN-validated.** All
  four acceptance-criteria numbers (200ms, 5 min, 3 ledger closes, 33%
  offline) are exercised by the chaos scripts in §7 against the local
  docker-compose bridge network, which has negligible latency/partition
  behavior compared to a real geo-distributed deployment. Treat the chaos
  scripts as regression tests proving the mechanisms work, not as a
  performance guarantee at production WAN scale.
- **Single-pass implementation risk**: this touches four largely-independent
  subsystems plus a nontrivial build-pipeline change in one implementation
  pass. The areas most likely to need follow-up hardening, in rough order
  of risk: (1) NAT traversal, for the reason above; (2) the exact libp2p
  dependency pins in §5, which will need re-verification whenever
  `@chainsafe/libp2p-gossipsub` eventually catches up to `@libp2p/interface`
  v3 and a version bump becomes worth doing; (3) the range-boundary edge
  case above under sustained production load with real reorgs.
