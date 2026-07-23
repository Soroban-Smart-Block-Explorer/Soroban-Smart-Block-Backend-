# Governance & DAO Framework — Design Document

Issue: [#567 — Decentralized Governance & DAO Framework](https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/issues/567)

This document describes the architecture for turning the existing governance
stubs (`GovernanceContract`, `GovernanceProposal`, `GovernanceVote`,
`GovernanceDelegate`, `GovernanceTimelock`) into an end-to-end governance
framework supporting four governance models, delegation / liquid democracy,
treasury management, and timelocked execution.

---

## 1. Scope & System Boundary

This backend is a **block explorer and governance hub**, not a wallet. That
boundary drives every design decision below:

- **The backend never holds keys and never signs.** "Create proposal", "cast
  vote", and "execute" endpoints build and validate unsigned Soroban
  transaction envelopes (XDR), simulate them via the existing
  `/api/v1/simulate` machinery, and return them to the client for signing.
  Clients submit signed transactions to the network themselves (or through the
  existing transaction relay endpoints).
- **The chain is the source of truth.** The indexer
  (`src/indexer/governance.ts`) already ingests governance events
  (`proposal_created`, `vote_cast`, `proposal_executed`, …) emitted by Soroban
  governance contracts. The framework extends this ingestion; API writes are
  *intent registration + XDR building*, and final state always comes from
  indexed events.
- **Off-chain governance is also first-class.** Draft proposals, text
  proposals, and vote signalling that never touch the chain are stored
  directly, clearly flagged `onChain: false`.

This "prepare → sign client-side → index result" pattern is the same one used
by every serious governance frontend (Tally, Snapshot's on-chain execution,
1Hive Gardens) and keeps the explorer trustless.

## 2. Current State (What Exists Today)

| Piece | State | Problems |
|---|---|---|
| `prisma/schema.prisma` governance models | Stubs | `GovernanceContract.proposals` is a `Json?` blob; **no relations** between contract/proposal/vote/delegate |
| `GovernanceVote` | Stub | `support Boolean?` but the indexer and API both treat it as a string (`'for' \| 'against' \| 'abstain'`); FK points at `GovernanceProposal.id` (cuid) while the indexer writes the **on-chain** proposal id → FK violations |
| `src/api/governance.ts` | Read-only, **unmounted** | Listed in `PENDING_SCHEMA_ROUTERS` (scripts/validate-routes.ts); `include`s relations that don't exist in the schema |
| `src/api/treasury.ts` | Static stubs, **unmounted** | Returns empty hardcoded payloads; no models behind it |
| `src/indexer/governance.ts` | Working event ingestion | Writes shapes that mismatch the schema (see above) |
| `GovernanceTimelock` + `src/api/schedule.ts` | Working | Standalone; loosely coupled by `(contractAddress, proposalId)` strings — kept as-is to avoid breaking `schedule.ts` |

Phase 1 (schema) fixes the mismatches **without renaming any field referenced
by existing code** (`schedule.ts`, `reputation/score.ts`,
`indexer/upgrade-governance.ts`, `indexer/temporal-scanner.ts` are all
preserved). `scripts/validate-prisma-references.ts` is the CI gate for this.

## 3. Architecture Overview

```
                       ┌────────────────────────────────┐
                       │  src/api/governance/ (routers) │
                       │  proposals · votes · delegation│
                       │  execution · treasury · stats  │
                       └───────────────┬────────────────┘
                                       │ zod-validated DTOs
                       ┌───────────────▼────────────────┐
                       │ src/services/governance/       │
                       │                                │
                       │  proposal-lifecycle.ts  (FSM)  │
                       │  strategies/                   │
                       │    token-weighted.ts           │
                       │    quadratic.ts                │
                       │    conviction.ts               │
                       │    multisig.ts                 │
                       │  delegation.ts (graph resolver)│
                       │  execution.ts  (XDR + timelock)│
                       │  treasury.ts   (accounts/streams)│
                       └──────┬──────────────────┬──────┘
                              │                  │
                 ┌────────────▼─────┐   ┌────────▼─────────────┐
                 │ Prisma / Postgres│   │ Soroban RPC          │
                 │ (indexed state,  │   │ (simulateTransaction,│
                 │  drafts, intents)│   │  reuses src/api/     │
                 └────────▲─────────┘   │  simulate pipeline)  │
                          │             └──────────────────────┘
                 ┌────────┴─────────┐
                 │ src/indexer/     │
                 │ governance.ts    │  ← chain events remain the
                 │ (event ingestion)│    source of truth
                 └──────────────────┘
```

### The strategy pattern

All four governance models share the proposal lifecycle, storage, delegation,
and execution pipeline. They differ **only** in how voting power is computed
and how a tally decides pass/fail. That difference is isolated behind one
interface:

```ts
interface VotingStrategy {
  readonly model: 'token_weighted' | 'quadratic' | 'conviction' | 'multisig';

  /** Voting power for `voter` at the proposal's snapshot point. */
  getVotingPower(ctx: StrategyContext, voter: string): Promise<Power>;

  /** Validate + price a vote (e.g. quadratic credit cost, multisig membership). */
  validateVote(ctx: StrategyContext, vote: VoteIntent): Promise<VoteValidation>;

  /** Fold votes into a tally. Conviction re-computes time-decayed weights here. */
  tally(ctx: StrategyContext, votes: Vote[]): Promise<Tally>;

  /** Given a tally + config (quorum, threshold), decide the outcome. */
  outcome(ctx: StrategyContext, tally: Tally): 'succeeded' | 'defeated' | 'pending';
}
```

`StrategyContext` carries the `GovernanceContract` row (which stores per-DAO
config as typed columns), the proposal, and a snapshot ledger sequence.
Adding a fifth model later = one new file implementing the interface + one
registry entry.

## 4. Governance Models — Trade-off Analysis

### 4.1 Token-Weighted (Compound/Governor-style) — the default

**How:** 1 token = 1 vote at a snapshot ledger (the proposal's `startBlock`
ledger sequence). Configurable quorum (basis points of total supply), voting
period (3–14 days ≈ ledger range), optional vote differential threshold.
Delegation applies (§6). Passed proposals are queued into the existing
`GovernanceTimelock` flow, and anyone can trigger execution after the delay.

**Voting power:** token balance via SEP-41 `balance()` (read through the
indexer's token-holder tables when available, RPC `getLedgerEntries` fallback),
plus inbound delegations, minus outbound delegation.

| Pros | Cons |
|---|---|
| Simple, battle-tested (Compound, Uniswap, ENS) | Plutocratic — whales dominate |
| Easy to verify on-chain | Vote buying is cheap and invisible |
| Efficient tally (sum of weights) | Voter apathy → quorum failures |

**Best for:** protocol parameter changes, upgrades — decisions where skin in
the game should scale with stake.

### 4.2 Quadratic Voting

**How:** each voter gets a **voice credit budget** per proposal round (config:
`voiceCreditsPerRound`, default 100). Casting *N* votes on one proposal costs
*N²* credits (10 votes on one proposal exhausts a 100-credit budget; ten
proposals can get ~3 votes each). Credits are tracked in
`GovernanceVoiceCredit`, debited by `validateVote`, refunded on vote change.

**Sybil resistance:** quadratic voting collapses if one holder can split
tokens across wallets (k wallets ⇒ k× effective power). Mitigations, layered:
1. `minTokenHolding` config — a wallet must hold ≥ X governance tokens at the
   snapshot to receive any credit budget (raises the cost of each Sybil).
2. Budget scales sub-linearly with balance (`credits = base ×
   min(1, balance/minHolding)`), never linearly — splitting is then
   power-neutral at best.
3. Optionally gate on the existing **reputation system**
   (`src/reputation/`) — `minReputationScore` config; reputation is much
   harder to Sybil than balances.

| Pros | Cons |
|---|---|
| Expresses *intensity* of preference | Sybil-vulnerable without identity — mitigations above are dampeners, not cures |
| Anti-plutocratic (cost grows quadratically) | Harder to explain to voters |
| Great for allocation across many options | Credit bookkeeping adds state |

**Best for:** community fund allocation, grant rounds — exactly what the
issue prescribes. Not recommended for security-critical upgrades.

### 4.3 Conviction Voting (1Hive-style)

**How:** voters *stake* tokens on proposals; conviction accrues over time
toward the staked amount following an exponential moving average:

```
conviction(t+Δ) = conviction(t) · α^Δ + stake · (1 − α^Δ)
```

with per-ledger half-life parameter α (config `convictionHalfLifeLedgers`,
default ≈ 3 days of ledgers). A proposal passes when conviction crosses a
dynamic threshold that scales with the fraction of the shared pool it
requests (bigger asks need more conviction). Stakes are re-allocatable at any
time; conviction then decays for the old proposal and grows for the new one.

**No voting period** — proposals are continuous, which is why the issue
suggests it for ongoing resource allocation (e.g. contract indexing
priority). Contesting a proposal = staking on a competing proposal or simply
waiting for decay.

**Implementation note:** conviction is stored as `(lastConviction,
lastUpdateLedger)` per stake and **recomputed lazily on read** — no cron
recalculating every stake every block. `tally()` folds the closed-form decay
formula; O(#stakes) per read with no background jobs.

| Pros | Cons |
|---|---|
| Continuous — no proposal deadlines, no quorum games | Slow by design; wrong tool for urgent decisions |
| Time-commitment resists flash-loan / last-minute attacks | Capital is locked while staked |
| Threshold auto-scales with request size | Parameters (half-life, threshold curve) are unintuitive |

**Best for:** continuous budget streams, prioritization queues.

### 4.4 Multisig (Gnosis Safe-style)

**How:** a configured signer set (`GovernanceMultisigSigner`) and threshold
M-of-N. "Proposals" are transactions; "votes" are confirmations
(`support = 'confirm'`). Threshold reached ⇒ `succeeded` immediately (quorum
and voting-period rules short-circuit). Execution still flows through the
shared pipeline (timelock optional, often 0 for multisigs). Mirrors Soroban
multisig custom-account contracts — the indexer ingests their
`add_signer` / `remove_signer` / `set_threshold` events to keep the signer
set in sync.

| Pros | Cons |
|---|---|
| Fast, cheap, predictable | Centralized — trust in N people |
| No token needed | No community voice |
| Perfect executor for other models' decisions | Signer churn needs careful indexing |

**Best for:** treasuries, emergency guardians, early-stage DAOs. Commonly
**composed**: token-weighted vote decides, multisig executes; the framework
supports a DAO having multiple `GovernanceContract` rows with different
models for exactly this.

### 4.5 Summary matrix

| | Token-weighted | Quadratic | Conviction | Multisig |
|---|---|---|---|---|
| Sybil resistance | High (capital) | **Low → needs mitigations** | High (capital+time) | High (identity) |
| Plutocracy resistance | Low | High | Medium | N/A |
| Decision latency | Days | Days | Weeks (by design) | Minutes |
| Voter cost | Low | Medium | High (locked capital) | Low |
| On-chain complexity | Low | Medium | High | Low |
| Primary use here | Upgrades, parameters | Grants, fund allocation | Continuous allocation | Treasury, guardian |

## 5. Proposal Lifecycle (shared FSM)

```
                     ┌──────────┐
       off-chain ───▶│  draft   │──── submit (build XDR, simulate ok)
                     └────┬─────┘
                          ▼
                     ┌──────────┐  startBlock reached
                     │ pending  │─────────────┐
                     └────┬─────┘             ▼
                     cancel│            ┌──────────┐   endBlock reached,
                          │            │  active  │──── outcome()
                          ▼            └────┬─────┘
                     ┌──────────┐           │succeeded          │defeated
                     │cancelled │◀──guardian┌▼─────────┐   ┌────▼─────┐
                     └──────────┘   cancel  │  queued  │   │ defeated │
                          ▲                 └────┬─────┘   └──────────┘
                          │        timelock delay elapsed
                          │                 ┌────▼─────┐ tx failed ┌────────┐
                          └─────────────────│executing │──────────▶│ failed │
                                            └────┬─────┘           └────────┘
                                                 │ tx confirmed
                                            ┌────▼─────┐
                                            │ executed │
                                            └──────────┘
```

- Transitions are enforced in `proposal-lifecycle.ts` with an explicit
  transition table; illegal transitions throw typed errors (400s at the API).
- `status` remains a **string column** with this canonical set (`draft`,
  `pending`, `active`, `queued`, `executing`, `executed`, `defeated`,
  `failed`, `cancelled`, `expired`) because existing code
  (`indexer/governance.ts`, `api/schedule.ts`) already compares string
  statuses; introducing a Prisma enum would be a breaking migration for live
  rows with no benefit. Validation lives in the service layer.
- Conviction proposals use a reduced FSM (`active → queued → executed`,
  contestable while active); multisig skips `pending` (immediately `active`).

**Proposal templates** (`parameter_change`, `fund_transfer`,
`contract_upgrade`, `text`) are server-side payload builders: given template
kind + typed params, the service builds `targets` / `values` / `calldatas`
(Soroban contract invocations as base64 `InvokeContractArgs`), so frontends
don't hand-craft XDR. `text` proposals have empty payloads and skip
queue/execute (terminal state: `executed` on passage, marked
`executionKind: 'none'`).

## 6. Delegation & Liquid Democracy

**Model:** `GovernanceDelegation` rows are edges `delegator → delegatee`,
scoped per governance contract, optionally per **category** (`all`,
`tech`, `treasury`, `grants`, … free-form, validated against the contract's
configured category list). Revocation sets `revokedAt` (edges are never
deleted — the history feeds analytics) and takes effect immediately: power
resolution only considers edges where `revokedAt IS NULL`.

**Resolution:** voting power for voter V on proposal P =

```
ownPower(V) − outboundDelegation(V, category(P))
            + Σ inbound chains resolved recursively, max depth 10
```

- Depth-limited DFS (`MAX_DELEGATION_DEPTH = 10` per acceptance criteria)
  with an explicit visited-set → **cycle-safe** (A→B→A contributes each
  wallet once, then stops).
- If V has delegated away for the proposal's category but votes anyway, V's
  *own* vote overrides the delegation for that proposal (Governor Bravo
  semantics: explicit vote > delegation), implemented by subtracting V's own
  power from the delegate's resolved power at tally time when both voted.
- Resolution happens at **tally/read time** against the snapshot; edges
  carry `createdAt`/`revokedAt` so historical proposals resolve against the
  edges active at their snapshot.

**Analytics endpoints** (read-only): delegation flow graph (nodes+edges JSON
for the frontend's viz), top delegates by resolved power, delegation "ROI"
(participation rate of delegate vs. delegators' idle power).

## 7. Treasury Management

New models: `TreasuryAccount` (one per DAO treasury; governance contract FK;
multisig config), `TreasuryAsset` (per-asset balances: native XLM, SEP-41
tokens incl. USDC, wrapped ETH, governance token, LP tokens — issue requires
5+ asset kinds; balances refreshed by the indexer from transfer events),
`TreasuryPayoutStream` (recipient, token, `amountPerPeriod`,
`periodSeconds`, start/end, claimed-so-far; streams are proposal-created and
their claims are executable payloads), `TreasuryTransaction` (indexed
inflow/outflow ledger with category tags).

- Spending = a `fund_transfer` proposal in whichever governance model the
  treasury is configured with (commonly multisig, per §4.4 composition).
- **Reputation-weighted treasury proposals**: optional per-treasury config
  `reputationWeight` blends voting power as
  `power = tokenPower × (1 − w) + reputationScore × w` using the existing
  `src/reputation/score.ts` profiles — integration point the issue asks for.
- Analytics: inflow/outflow time series, allocation breakdown, runway =
  liquid assets ÷ trailing-90-day net burn (all computed from
  `TreasuryTransaction`, cached).

## 8. Timelock & Execution

- Reuses the existing **`GovernanceTimelock`** model and
  `src/api/schedule.ts` surfaces (kept loosely coupled by
  `(contractAddress, proposalId)` — no FK added, so `schedule.ts` and
  `temporal-scanner.ts` keep working untouched).
- Queueing a succeeded proposal creates the timelock row (`minDelay` from
  the governance contract's config, default 48 h) with `executionTime` and
  `operationHash` (hash of targets/values/calldatas — execution verifies the
  payload matches what was voted on).
- **Anyone can execute** after `executionTime`: the endpoint returns the
  prepared execution XDR to whoever asks; the indexer flips the proposal to
  `executed` when the on-chain event lands.
- **Guardian cancel:** each governance contract may configure a `guardian`
  address; a guardian-signed cancel (verified via the tx's source account on
  the indexed cancel event, or SEP-53 signed message for off-chain drafts)
  moves `queued → cancelled` before execution.
- **Execution simulation** (`GET /proposals/{id}/execution`): builds the
  execution transaction and runs it through the existing simulate pipeline
  (`src/api/simulate.ts` internals: footprint, storage classification, call
  trace, ABI-aware failure diagnostics), returning expected state changes and
  failure conditions **without** touching the chain.

## 9. API Surface (mounted under `/api/v1/governance`)

The existing read endpoints in `src/api/governance.ts` are kept (fixed to the
new relations). New endpoints per the issue:

| Method & path | Purpose |
|---|---|
| `GET /governance/proposals` | list; filters: status, proposer, contract, date range (extended) |
| `POST /governance/proposals` | create draft/submit from template; returns unsigned XDR for on-chain models |
| `POST /governance/proposals/{id}/votes` | cast/register vote → validated by strategy, returns unsigned vote XDR (on-chain) or records signal (off-chain, SEP-53 signature verified) |
| `POST /governance/delegation` | create delegation edge (signature-verified); `DELETE` to revoke |
| `GET /governance/proposals/{id}/execution` | simulate execution; failure conditions, state diff |
| `POST /governance/proposals/{id}/queue` · `/execute` · `/cancel` | lifecycle transitions (XDR builders + FSM guard) |
| `GET /governance/delegation/graph?contract=…` | delegation flow graph, top delegates, ROI |
| `GET /governance/treasury/…` | accounts, assets, streams, analytics (replaces stub `treasury.ts` payloads) |

Conventions (all enforced by existing CI): `asyncHandler` on every async
handler, zod validation, shared `logger`, kebab-case route prefixes, routers
mounted in `src/api/router.ts` and **removed from `PENDING_SCHEMA_ROUTERS`**.

Write-path authentication: on-chain actions are self-authenticating (the
user signs the returned XDR; state comes from indexed events). Off-chain
writes (drafts, vote signals, delegation registration) require a SEP-53
signed message from the acting address — no sessions, no custody.

## 10. Data Model Changes (Phase 1 summary)

Full schema in `prisma/schema.prisma`; the shape:

- `GovernanceContract` — add typed config columns (votingModel, quorumBps,
  votingPeriodLedgers, timelockDelaySecs, guardian, voiceCreditsPerRound,
  minTokenHolding, convictionHalfLifeLedgers, categories); add **real
  relations** to proposals/votes/delegates/delegations; drop the dead
  `proposals Json?` blob.
- `GovernanceProposal` — add `votingModel`, `template`, `snapshotLedger`,
  `queuedAt`, `eta`, `cancelledBy`, `executionKind`; relation to contract;
  keep every existing column (indexer compatibility).
- `GovernanceVote` — **fix `support` to `String?`** and `weight` stays
  numeric but the indexer's string writes are corrected; **fix the broken FK**
  to reference `GovernanceProposal` by its composite natural key
  `(contractAddress, proposalId)` instead of the cuid; add `voiceCredits`
  (quadratic), `stakeAmount`/`convictionAt`/`lastUpdateLedger` (conviction).
- `GovernanceDelegation` (new) — delegation edges (§6).
- `GovernanceDelegate` — kept as the aggregate/leaderboard cache the API
  already reads; now maintained from `GovernanceDelegation` edges.
- `GovernanceVoiceCredit` (new) — quadratic budgets per (contract, round,
  holder).
- `GovernanceMultisigSigner` (new) — signer sets + threshold history.
- `TreasuryAccount` / `TreasuryAsset` / `TreasuryPayoutStream` /
  `TreasuryTransaction` (new) — §7.
- `GovernanceTimelock` — **unchanged** (see §8).

Every new FK/lookup field gets `@@index` (CI: `npm run audit:indexes`).
Existing data: migration is additive except the `GovernanceVote.support`
type change (`Boolean?` → `String?`), migrated with
`USING (CASE WHEN support THEN 'for' WHEN NOT support THEN 'against' END)`;
and the vote FK swap, preceded by deleting orphaned votes (they were
unwritable before — the FK was broken — so this is a no-op on real data).

## 11. Delivery Plan

| Phase | Contents | PR |
|---|---|---|
| 0 | This design doc | with Phase 1 |
| 1 | Schema rework + migration + indexer type fixes | PR 1 |
| 2 | Strategy services, FSM, delegation resolver, timelock/execution service + unit tests | PR 2 (or same PR, separate commits, per maintainer preference) |
| 3 | API endpoints, mounting, `PENDING_SCHEMA_ROUTERS` cleanup, integration tests | PR 3 |
| 4 | Treasury endpoints/analytics + reputation integration | PR 4 |

Acceptance-criteria mapping: 4 models end-to-end (§4, §5); <1 h
propose→vote→execute on testnet (achievable: config allows short
voting periods and 0 timelock on testnet contracts); delegation depth 10
(§6); 5+ treasury asset types (§7); trade-off analysis (§4.5).

## 12. Testing Strategy

- **Unit** (vitest, no DB): each `VotingStrategy` (power/cost/tally/outcome
  edge cases — quadratic budget exhaustion, conviction decay closed-form,
  multisig threshold), FSM transition table, delegation resolver (chains,
  cycles, depth-10 truncation, category scoping, override semantics).
- **Integration** (existing `tests/db` harness): proposal lifecycle against
  Postgres, indexer event → API read round-trip, migration up on a seeded
  pre-migration database.
- **Simulation**: execution simulation mocked at the RPC boundary (fixtures
  from real testnet `simulateTransaction` responses, as `simulate.ts` tests do).
