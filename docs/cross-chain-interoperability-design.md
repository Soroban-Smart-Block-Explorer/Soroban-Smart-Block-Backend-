# Cross-Chain Interoperability Framework — Design Document

Issue: [#554 — Cross-Chain Interoperability Framework: Bridging Soroban with
Ethereum, Solana, and Cosmos via Light Clients and
ZK-Proofs](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/554)

This document is the acceptance-criteria-required design doc: it lays out the
architecture, security model, and game-theoretic analysis for a
trust-minimized (no trusted relayer) cross-chain framework connecting Soroban
to Ethereum, Solana, and Cosmos. **No code changes ship with this document.**
It exists to get the hard design decisions — especially the curve-mismatch
and trust-bootstrapping problems below — agreed before Phase 1 starts.

---

## 1. Scope & System Boundary

Same boundary principle as the [governance
framework](./governance-framework.md): **this backend never becomes the
trusted party.** That constraint shapes everything below, because it's
exactly the property the issue is asking for ("No Trusted Relayers").

- **The on-chain Soroban light-client + ZK-verifier contracts are the source
  of truth**, not this backend's Postgres database. A light client's state
  only advances when a submitted proof verifies *on-chain*. This backend can
  simulate/pre-check a proof before submission (fast feedback, same
  "prepare → sign/submit client-side" pattern used for governance), but it
  has no authority to mark cross-chain state as verified on its own say-so.
- **Proof generation is not this backend's job.** `gnark`, `arkworks`, and
  `bellman` (all named in the issue) are Go/Rust libraries with no
  production-grade Node/TS equivalent, and proof generation for a
  sync-committee or validator-set circuit is CPU-bound in a way that doesn't
  belong in an Express request handler. Proof generation lives in a new,
  separate service (§5). This backend indexes results, serves queries, and
  performs lightweight proof *pre-verification* (Groth16 verification is
  cheap — Node's `snarkjs` can do it directly if needed for the `/verify`
  simulation endpoint).
- **Indexing ("what happened") is explicitly separate from light-client
  verification ("what's cryptographically proven").** The existing
  `src/bridge-tracker/` watches known bridge contracts via RPC/API polling —
  it is a *trusted-relayer-model* system today (it trusts the RPC providers
  and the bridge protocol's own attestations, same as Wormhole guardians or
  Axelar validators). That's fine for analytics/alerting but is precisely
  the model this issue asks to move away from for anything security-critical.
  The new `CrossChainEvent` indexer (§6) inherits the same fast-but-trusted
  posture as `bridge-tracker` for the *query API*; only the light-client +
  ZK-proof path (§4, §5) carries the cryptographic "no trusted relayer"
  guarantee. Conflating the two would misrepresent indexed-but-unverified
  data as security-verified — the API responses in §7 are explicit about
  which fields carry which guarantee.

## 2. Current State (What Exists Today)

| Piece | State | Relevance |
|---|---|---|
| `src/bridge-tracker/` (`types.ts`, `config.ts`, `resolver.ts`, `finality.ts`, `alerts.ts`, `worker.ts`) | Working, trusted-relayer model | Watches known Wormhole/Axelar/Allbridge/Stargate contract addresses on `ethereum`/`solana`/`cosmos`/etc. via RPC polling; no cryptographic consensus verification. Reused for volume/liquidity aggregation in §7, **not** for the light-client path. |
| `src/api/bn254.ts` + `src/indexer/bn254-tracker.ts` | Working | BN254 (alt-bn128) curve constants and a CAP-0080 gas-exemption tracker (`bn254_pairing_check` etc.). This is the curve Soroban gives a native host-function gas exemption for — it becomes the **mandatory outer curve** for any Groth16 verifier this project deploys on-chain (see §5.1's curve-mismatch problem). |
| Soroban contract source | Not in this repo | This backend is API/indexer only; the on-chain light-client and ZK-verifier contracts are Wasm sources that live in a separate contracts repo (or a new one). This doc treats them as an external dependency and only specifies their required interface. |
| Cross-chain Prisma models | None | §8 sketches the new models; no migration is proposed in this document. |
| Issue-author's stated intent (issue #554 comment) | — | Assignee has signaled building ZK light clients on Soroban Wasm using off-chain proof generation "via systems like SP1 or Groth16" to compress Ed25519 (Cosmos) / BLS (Ethereum) signature verification into succinct proofs. This doc treats the proving-stack choice (SP1 zkVM vs. arkworks/gnark circuit) as an **open decision to confirm before Phase 2** (§12), not a decision this doc makes unilaterally. |

## 3. Architecture Overview

```
  Off-chain (new — separate Rust/Go service, NOT this Node backend)
  ┌───────────────────────────────────────────────────────────────────┐
  │  services/zk-prover/                                              │
  │   chain-listeners/  eth-beacon · solana-rpc · cosmos-tendermint    │
  │   circuits/         eth-sync-committee · solana-tower-bft · ibc   │
  │   prover/           SP1 zkVM  or  arkworks Groth16 (TBD, §12)     │
  │   → produces: Groth16(BN254) proof + public inputs                │
  └──────────────────────────┬────────────────────────────────────────┘
                              │ proof + header/commitment
                              ▼
  On-chain (Soroban Wasm — external repo, this doc specifies interface only)
  ┌───────────────────────────────────────────────────────────────────┐
  │  LightClient<Chain> contract   (one per chain: eth / sol / cosmos)│
  │    state: latestVerifiedHeight, headerHash, validatorSetCommitment│
  │    update(proof, newHeader) → verifies via ZKVerifier, then       │
  │                                 advances state (TLA+ spec, §9)    │
  │  ZKVerifier contract (Groth16-over-BN254, CAP-0080 gas exemption) │
  └──────────────────────────┬────────────────────────────────────────┘
                              │ events / RPC reads
                              ▼
  This backend (Soroban-Smart-Block-Backend-)
  ┌───────────────────────────────────────────────────────────────────┐
  │  src/cross-chain/indexer/   normalizes ETH logs, Solana program   │
  │                              logs, Cosmos IBC events → CrossChainEvent│
  │  src/cross-chain/watchtower.ts   anomaly detection, circuit breaker│
  │  src/api/cross-chain.ts     account / asset / bridge / verify     │
  │  Prisma: CrossChainEvent, LightClientState (mirror), BridgedAsset,│
  │          ProofSubmission, WatchtowerAlert                         │
  └───────────────────────────────────────────────────────────────────┘
```

`LightClientState` in this backend's database is a **read-through cache** of
on-chain contract state, refreshed by polling/subscribing to the Soroban
contract, never written independently — this is the concrete mechanism
enforcing the §1 boundary.

## 4. Light Client Verification, Per Chain

The issue's wording ("verify Casper FFG", "verify Solana's PoH") describes
consensus *mechanisms*, not the light-client *protocols* that make verifying
them tractable off a handful of KB per update. Below is the protocol each
chain's ecosystem has actually standardized for this exact purpose, since
reimplementing raw consensus verification (e.g. tracking Ethereum's 1M+
validator attestations directly) is not viable at the acceptance criterion's
<500ms budget.

### 4.1 Ethereum — Altair sync-committee light client

Ethereum's own [light client
spec](https://github.com/ethereum/consensus-specs) (post-Altair) exists
precisely so nobody has to track full Casper FFG/Gasper validator voting.
Mechanism:

- A **sync committee** of 512 validators is randomly resampled from the
  full active set every ~27 hours (256 epochs) and BLS-aggregate-signs each
  finalized block header.
- A light client verifies: (a) the aggregate BLS12-381 signature is valid,
  (b) the number of participating signers is ≥ 2/3 of 512 (≈342), (c) the
  current sync committee's pubkeys match a merkle-proven commitment carried
  forward from the last committee-period transition.
- Because the committee resamples from the *full* validator set, the
  probability that an attacker's corrupted minority ends up with ≥2/3 of a
  512-sample committee is negligible unless they already control a large
  share of total stake — i.e., security reduces to Ethereum's own staking
  security, not a separate weaker assumption (see §8.1).
- Account/storage proofs (needed for the "Ethereum storage proofs" the ZK
  engine must handle) are standard Merkle-Patricia-Trie inclusion proofs
  against the state root carried in a verified header.

This is the approach real Ethereum light clients (Helios, Succinct's
Telepathy/SP1 Helios, Nimbus LC) use, and it's the only one that fits the
proof-generation budget.

### 4.2 Solana — Tower BFT vote verification

PoH is a verifiable clock, not a consensus/finality mechanism by itself —
Tower BFT (stake-weighted voting with lockouts over a PoH-ordered ledger) is
what actually finalizes blocks, so "verify PoH" alone proves nothing about
finality; the light client must verify **stake-weighted supermajority (≥2/3)
of vote transactions** on a given bank hash.

- Unlike Ethereum, Solana validators do not aggregate votes via BLS — each
  of (currently) 1,000+ validators signs individually with Ed25519. Proving
  ≥2/3 stake-weighted agreement therefore means verifying a large batch of
  individual Ed25519 signatures inside the circuit (expensive but batchable;
  Ed25519 batch verification is well-studied) rather than one aggregate
  check. This is materially more circuit work than Ethereum's single BLS
  aggregate check and is flagged as extra proving-time risk against the
  <30s generation budget.
- **Open risk, not yet resolved by this doc**: Solana does not expose a
  standard, stable RPC primitive for Merkle inclusion proofs of arbitrary
  account state against a bank hash (no equivalent of Ethereum's
  `eth_getProof`). Vote/finality verification is tractable; *state* proofs
  (needed to make Solana's asset-tracking as trust-minimized as Ethereum's)
  are not confirmed feasible today. §12 calls for a feasibility spike before
  Phase 3 is scheduled, and Phase 3 scope may ship vote/finality
  verification only, without full state proofs, if the spike confirms the
  gap.

### 4.3 Cosmos — ICS-07 Tendermint light client

The most tractable of the three, and should be built first (§11):

- Cosmos already has a mature, standardized [IBC light client
  spec](https://github.com/cosmos/ibc) (ICS-07 for Tendermint headers,
  ICS-23 for Merkle state proofs) implemented across dozens of chains.
  Verification is: (a) a Tendermint header's commit has ≥2/3 voting-power
  signatures (individually Ed25519-signed, typically O(100) validators per
  zone — far fewer than Ethereum or Solana, so direct or lightly-ZK-wrapped
  verification is cheap), (b) validator-set transitions carry forward within
  a **trusting period** (bounded by 2/3 of the chain's unbonding period, per
  IBC's spec — e.g. commonly ~2-3 weeks), (c) ICS-23 Merkle proofs for
  counterparty state reads.
- Because the protocol semantics are already standardized and open-source,
  the implementation cost here is porting/adapting ICS-07/ICS-23 verification
  into a Soroban contract (+ optional ZK-wrapping purely for gas, not for
  correctness), not inventing new verification logic. Lowest technical risk
  of the three chains — see phasing in §11.

## 5. ZK-Proof Verification Engine

### 5.1 The BN254 / BLS12-381 curve mismatch (central technical risk)

Soroban's CAP-0080 gas exemption is scoped to **BN254 (alt-bn128)** pairing
operations (`src/api/bn254.ts`, `src/indexer/bn254-tracker.ts` already model
this). That means any on-chain Groth16 verifier deployed on Soroban should
target BN254 as its **outer** proving curve to be gas-efficient — that part
is a straightforward design constraint.

The complication: Ethereum's sync-committee signatures are BLS12-381
(Ethereum consensus never used BN254), and Cosmos/Solana votes are Ed25519.
None of those are natively BN254 operations. The standard solution (used by
production Ethereum light-client provers) is **proof recursion**: prove the
BLS12-381/Ed25519 signature-verification statement in a first circuit, then
wrap/recurse that proof into an outer Groth16 proof over BN254 so the
on-chain verifier only ever checks one curve. This recursion step is
non-trivial engineering and is the single largest cryptographic risk in this
project — it should be spiked (small end-to-end proof-of-concept: one
sync-committee update, proven and verified on a BN254 Soroban verifier)
before Phase 2's timeline is committed to (§12).

### 5.2 Off-chain prover service

New, separate deployable — not part of this Express app — because none of
the candidate proving stacks (`gnark`: Go, `arkworks`/`bellman`: Rust, `SP1`
zkVM: Rust) have a production Node/TS runtime:

- `services/zk-prover/` (proposed): chain listeners per source chain →
  circuit inputs → proof generation → exposes an internal API (gRPC or HTTP)
  this backend calls to (a) request a proof for a pending light-client
  update, (b) pre-verify a proof before submission.
- Confirm SP1-zkVM vs. arkworks/gnark-circuit before Phase 2 starts (issue
  assignee has signaled SP1 in their own comment on #554) — this changes the
  `POST /cross-chain/verify` request/response contract (§7) and is listed as
  an open decision in §12, not settled by this document.

### 5.3 Batch/aggregate verification

Aggregating N proofs into one (for gas efficiency, per the issue) is a
**Phase 4 optimization** (§11), not MVP — it adds a second layer of
recursion on top of an already-nontrivial recursion problem (§5.1) and isn't
needed until proof-submission volume justifies the extra engineering cost.

### 5.4 On-chain verifier contract template

Out of this repo's boundary (§1) — this backend doesn't own Soroban contract
source. This doc's contribution is the **required interface**: a
`verify(proof: BytesN<...>, public_inputs: Vec<...>) -> bool`-shaped
Groth16-BN254 verifier, callable by each per-chain `LightClient` contract,
with a fixed verification key baked in at deploy time per proving circuit
version.

## 6. Unified Multi-Chain Indexer

Reuses the ingestion pattern already established by `src/indexer/*` and
`src/bridge-tracker/worker.ts` — per-chain listeners normalizing into one
shape:

```ts
interface CrossChainEvent {
  id: string;
  chain: 'ethereum' | 'solana' | 'cosmos';
  eventType: string;              // e.g. 'transfer', 'bridge_deposit', 'ibc_packet'
  txHash: string;
  blockRef: string;               // block number / slot / height, chain-specific
  contractOrProgram: string;
  sender?: string;
  recipient?: string;
  asset?: string;                 // resolved via BridgedAssetMapping where possible
  amount?: string;
  payload: unknown;               // chain-specific raw shape, Json
  verifiedAtLightClientHeight: string | null; // null = indexed only, not yet light-client-verified
  createdAt: Date;
}
```

`verifiedAtLightClientHeight` is the field that makes the §1 trust
distinction explicit and machine-checkable: `null` means "we saw this via
RPC/API polling, same trust model as `bridge-tracker` today"; non-null means
"this event's block is at or below a height this backend's `LightClientState`
mirror has independently confirmed as ZK-verified on-chain."

Bridge-attack detection (compromised validators, fake deposits, reorg
attacks) reuses `src/bridge-tracker/finality.ts`'s reorg-detection pattern
and `alerts.ts`'s threshold-checking pattern, extended to also flag any
`CrossChainEvent` that claims a `blockRef` *above* the corresponding chain's
current `LightClientState.latestVerifiedHeight` combined with an anomalous
volume/pattern (feeds the watchtower in §8.3).

## 7. Cross-Chain Query API

All four endpoints mount under `/api/v1/cross-chain` (new `src/api/cross-chain.ts`, wired into `src/api/router.ts` the same way every other router is — see the CI-enforced `scripts/validate-routes.ts` registry, and note the `src/api/auth.ts` mounting gap fixed alongside this doc as a cautionary example of what happens when a router is left off that registry).

| Endpoint | Behavior | Trust label in response |
|---|---|---|
| `GET /cross-chain/account/{address}` | Aggregates `CrossChainEvent` across chains for a given address. **Open question (§12)**: without a signature-based proof of cross-chain address ownership, this is an address-list lookup, not a verified identity link — chain-specific address formats (`0x…` hex / base58 / bech32) also mean this can't be a single string match and needs either explicit per-chain address input or a future `AddressLink` model. | `verified: false` per event unless `verifiedAtLightClientHeight` is set |
| `GET /cross-chain/asset/{asset_id}` | Joins `BridgedAssetMapping` + existing `src/services/pricing` + transfer volume from `CrossChainEvent` | Same per-event trust label |
| `GET /cross-chain/bridge/{bridge_id}` | Extends existing `src/bridge-tracker/liquidity.ts` TVL/volume aggregation with a `securityAudits` field (static/config-sourced) | N/A — analytics, not a security claim |
| `POST /cross-chain/verify` | Accepts `{chain, proofType, proof, publicInputs}`; forwards to the `zk-prover` service (§5.2) for **pre-verification only** — mirrors the governance framework's "prepare → sign/submit client-side" pattern (this backend's response is a simulation result; the client still submits the proof to the on-chain `LightClient` contract themselves, which is the only place the state actually advances) | Response explicitly labeled `simulated: true` |

## 8. Security Hardening

### 8.1 Economic security, per chain

These are **order-of-magnitude, illustrative** figures — actual staked
value moves daily and should be pulled live (e.g. via the existing
`src/services/pricing` infra) into an operational dashboard rather than
hardcoded, but the *shape* of the argument is what matters for the design:

| Chain | What must be corrupted to forge a proof | Reduces to |
|---|---|---|
| Ethereum | ≥2/3 of a randomly-resampled 512-member sync committee, repeatedly across resample periods, *or* find a soundness bug in the sync-committee/BLS verification circuit | Ethereum's own PoS security (tens of billions of USD in staked ETH, order of magnitude) — the light client adds no weaker link **except** the circuit's own correctness and the weak-subjectivity checkpoint (§8.2) |
| Solana | ≥2/3 of the *stake active at that slot* | Solana's own PoS security — but see §4.2's unresolved state-proof gap, which is an availability/feasibility risk, not (yet) an economic-security one |
| Cosmos (per IBC counterparty zone) | ≥2/3 (or ≥1/3 for equivocation) of that **specific zone's bonded stake within its trusting period** | Varies enormously by zone — a small IBC-connected chain can have bonded stake orders of magnitude below Ethereum/Solana, so **bridge risk must be rated per connected chain, not treated as uniform** across the framework |

### 8.2 The weak-subjectivity caveat (applies to all three)

Every light client above needs a **trusted starting checkpoint** — none of
them replay history from genesis. If that initial checkpoint is
attacker-supplied, the cryptography downstream is sound but proves nothing
about the real chain. This means the *bootstrapping/checkpoint-distribution
process* is itself a trust decision this framework makes, and it should be
stated as such rather than implied away by "no trusted relayers" — the
honest claim is "no trusted relayer *after* a trust-minimized bootstrap,"
and the bootstrap process (who supplies the initial checkpoint, how it's
verified against multiple independent sources) needs its own design pass
before Phase 2 (tracked in §12).

### 8.3 Game-theoretic analysis

Framing: a rational attacker acts only when
`expected_profit > cost_to_corrupt (or find a bug) + P(detection) × (stake_slashed + reputational_loss)`.

- **Ethereum/Solana**: `cost_to_corrupt` vastly exceeds any plausible
  near-term bridge TVL on this platform, so a rational attacker's actual
  target is the *weakest link* — not the consensus economics but (a) the
  weak-subjectivity checkpoint (§8.2), (b) a soundness bug in the ZK circuit
  (a circuit bug lets an attacker forge proofs for **$0 stake cost**,
  bypassing the entire economic argument — this is why circuit audits and
  the TLA+ state-machine spec in §9 matter more than the raw dollar figure),
  (c) the off-chain `zk-prover` service or this backend itself, if either is
  ever given authority to mark state verified without the on-chain contract
  independently checking the proof (reinforces §1: the Soroban verifier
  contract must be the only authority).
- **Low-stake IBC counterparties**: here `cost_to_corrupt` can approach or
  fall *below* plausible bridged TVL — the economic-security argument
  genuinely breaks down, and operational controls carry the real weight.
  Recommend a concrete, enforceable policy: **cap bridged TVL per
  counterparty chain as a fraction of that chain's bonded stake** (the
  standard "economic security ratio" published by bridges like IBC/Axelar),
  enforced by the circuit breaker (§8.4).
- **Watchtower incentives**: monitoring is a public good — the classic
  free-rider problem applies if watchtowers are third-party-operated.
  Recommend MVP watchtowers be project-operated infra (no incentive design
  needed to ship), and defer a bonded-stake/slashing incentive layer for
  third-party watchtowers to a later phase (§11) — don't let incentive-design
  block the security-critical circuit-breaker mechanism from shipping.
- **Circuit breaker governance**: the breaker itself is a centralization
  point — "who can trigger or lift it" is a new trust decision if done by
  human override. Recommend it start as a fully automatic, code-defined
  threshold (>3σ from trailing 30-day mean daily volume, per the issue) with
  **no human-in-the-loop override for MVP**, avoiding a new trusted-party
  attack surface; revisit once the existing on-chain [governance
  framework](./governance-framework.md) (#567) can own that authority
  through its proposal/timelock machinery instead of an off-chain admin key.

### 8.4 Circuit breaker

Automatic, on the indexer side (§6): compare each chain's trailing 30-day
mean daily bridge volume (reusing `src/bridge-tracker/liquidity.ts`
aggregation) against the current day's volume; >3σ deviation raises a
`WatchtowerAlert` and flips a per-chain `haltBridgeOperations` flag that the
API (§7) surfaces so clients can choose to reject transfers — this backend
cannot itself halt on-chain contract operations (§1 boundary), so "halt" here
means "the indexer/API stops treating that chain's events as safe to
display/relay," while any actual on-chain pause would be a separate
governance action.

## 9. Formal Verification Scope (TLA+)

Formally verifying an entire BLS/Ed25519 circuit or Ethereum's consensus
client is out of reach for this project and not what the acceptance
criterion should be read as requiring. Scoped instead to what's tractable
and actually catches the bug class that has caused most real-world bridge
hacks (e.g., Wormhole's 2022 exploit was a **guard-check bug** — a missing
signature-account validation — not a broken cryptographic primitive):

**In scope**: a TLA+ spec of the on-chain `LightClient` contract's state
machine — `Uninitialized → Bootstrapped(checkpoint) → Verified(height,
header, committeeCommitment) → Verified(height', ...) → ...` — with the
transition guard `advance(proof, newHeader)` requires `verify(proof) = true
∧ newHeader.height > state.height ∧ committee-continuity holds`. Checked via
TLC for:

- **Safety**: the contract can never simultaneously hold two conflicting
  verified headers at the same height (no double-finalization).
- **Safety**: state can only advance through a successful proof
  verification call — no code path mutates `latestVerifiedHeight` without
  one.
- **Liveness** (best-effort, not an MVP blocker): if the source chain is
  live/honest and at least one prover submits proofs, the light client
  eventually advances.

**Explicitly out of scope**: this spec assumes the SNARK verifier and the
underlying BLS/Ed25519 checks it wraps are correct — that assumption is
addressed separately via circuit audits and the proving-stack's own tooling
(e.g. arkworks/gnark's constraint-system test suites), not TLA+. Stating this
boundary up front avoids the acceptance criterion being read as "formally
verify the cryptography," which is a different, much larger undertaking.

## 10. Data Model Additions (sketch, not a migration)

```
CrossChainEvent      — see §6 shape
LightClientState     — chain, latestVerifiedHeight, headerHash,
                        validatorSetCommitment, lastSyncedAt (read-through
                        cache of on-chain contract state, §3)
BridgedAssetMapping   — canonicalAssetId, chain, tokenAddress, decimals
ProofSubmission       — chain, proofType, status (pending/verified/rejected),
                        submittedBy, verifiedAtTx
WatchtowerAlert       — chain, alertType, severity, metrics snapshot,
                        triggeredAt, acknowledged
```

Modeled after the existing `AuthSession`/`AuthEvent`-style additive pattern
(`prisma/schema.prisma`) and the `Bridge*` volume/alert models
`src/bridge-tracker/` already uses — no destructive changes to any existing
model. A real migration is a Phase 1 deliverable, not part of this doc.

## 11. Phasing

| Phase | Scope | Exit bar |
|---|---|---|
| 0 (this doc) | Design, TLA+ state-machine spec, live economic-security dashboard spec, curve-mismatch spike plan | Reviewed/agreed before Phase 1 code starts |
| 1 | Cosmos IBC light client only (lowest risk, standardized spec) + `CrossChainEvent` indexer + read-only query API (indexer-backed, no ZK yet) + heuristic (non-ZK) watchtower v0 | De-risks indexer/API/watchtower architecture before the hard crypto; ships user-visible value fastest |
| 2 | Ethereum sync-committee light client + Groth16/BN254 verifier + `zk-prover` service + `POST /verify` | The acceptance-criteria-bearing phase: <500ms header verification, <30s proof generation, <100ms on-chain verification |
| 3 | Solana — **contingent on the state-proof feasibility spike (§4.2)** | May ship vote/finality verification only if the spike confirms the state-proof RPC gap |
| 4 | Batch/aggregated proof verification, watchtower staking/incentive layer, circuit-breaker governance handoff to #567 | Optimization + decentralization, not correctness-blocking |

## 12. Open Decisions (must resolve before the phase that needs them)

- **Curve-mismatch recursion spike (§5.1)** — before Phase 2's timeline is
  committed to. Highest-risk unknown in the whole project.
- **Proving stack: SP1 zkVM vs. arkworks/gnark circuits (§5.2)** — before
  Phase 2 starts; changes the `POST /verify` proof-format contract.
  Assignee has signaled SP1 in their issue comment; needs explicit
  confirmation, not assumption.
- **Solana state-proof RPC feasibility (§4.2)** — before Phase 3 is
  scheduled.
- **Weak-subjectivity checkpoint bootstrap/governance (§8.2)** — before
  Phase 2; who supplies/rotates the trusted checkpoint, and how is that
  itself checked against independent sources rather than implicitly trusted.
- **Cross-chain address ownership proof for `/account` (§7)** — decide
  whether Phase 1's endpoint is a plain address-list lookup (ships now) or
  requires a signature-based `AddressLink` (deferred).
