# Soroban ZK-Rollup L2 Design Document

## Executive Summary

This document outlines the architecture for a ZK-Rollup Layer 2 scaling solution for Soroban. The design targets >10,000 tx/s throughput, <30 minute proof generation for 1,000 transactions, and <500k gas for L1 verification per batch.

---

## Motivation

Soroban mainnet currently processes approximately 1,000 tx/s. Complex contract interactions (DEX arbitrage, MEV strategies, yield optimizers) are cost-prohibitive on L1. A ZK-Rollup L2 batches contract executions off-chain and submits a single validity proof to L1, achieving massive throughput gains while inheriting L1 security.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        L2 LAYER                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Sequencer   │──▶│  zkWASM      │──▶│  Proof Aggregation     │ │
│  │  (round-robin)│   │  Executor    │   │  (recursive SNARK)     │ │
│  └──────────────┘   └──────────────┘   └────────────────────────┘ │
│         │                  │                          │          │
│         ▼                  ▼                          ▼          │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │              L2 State: Sparse Merkle Tree                    ││
│  │  [contract wasm hashes, storage entries, balances, events]   ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ Validity Proof + New State Root
┌─────────────────────────────────────────────────────────────────┐
│                        L1 (SOROBAN MAINNET)                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │            L1 Verifier Contract (Soroban WASM)             │  │
│  │  • Verifies ZK proof (Groth16 on BN254)                    │  │
│  │  • Updates L2 state root                                    │  │
│  │  • Handles fraud proofs, forced inclusion, escape hatch    │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## State Model: Sparse Merkle Tree

- **Leaf structure**: `hash(contract_address || storage_key) → storage_value`
- **Contract metadata leaf**: `hash("meta" || contract_address) → { wasm_hash, deployed_at, admin }`
- **Balance leaf**: `hash("balance" || token_address || account) → i128`
- **Event leaf**: Merkle-ized append-only log (one leaf per event, root committed per batch)
- **Tree depth**: 256 (matching Soroban's 32-byte keys); sparse representation uses zero-filled paths for empty leaves
- **State root**: 32-byte digest committed to L1 per batch

---

## Execution Environment: zkWASM Circuit

### Target: Deterministic WASM Interpreter inside ZK Circuit

| Component | Approach |
|-----------|----------|
| **Instruction set** | Subset of WASM MVP + SIMD (minimize constraints per instruction) |
| **Memory model** | Linear memory with Merkle-ized reads/writes (per-access proof) |
| **Host functions** | Precompiled circuits for each Soroban host function (see below) |
| **Call depth** | Tracked via explicit stack frame circuit; max depth = 64 |
| **Gas metering** | Per-instruction counter enforced in circuit; batch gas limit |

### Host Functions Circuitized

| Host Function | Circuit Strategy |
|---------------|------------------|
| `storage_read` / `storage_write` | Sparse Merkle proof verification (path + sibling hashes) |
| `contract_call` | Sub-circuit with separate call frame; depth counter |
| `emit_event` | Append to event Merkle tree; emit event root in batch public input |
| `ed25519_verify` | Use RISC Zero / SP1 precompile or native BN254 curve for scalar mult |
| `sha256` / `keccak256` / `blake2b` | Existing Plonky3 / Halo2 gadgets |
| **SEP-41 token ops** | `transfer`, `mint`, `burn`, `approve` as specialized sub-circuits to avoid generic WASM overhead |

### Circuit Optimization

- **Constraint minimization**: Custom gates for WASM opcodes (e.g., `i32.add` → single constraint)
- **Lookup tables**: For host function dispatch, memory opcodes, bitwise ops
- **Batch transactions**: Multiple txs in single proof via sequential state transition circuit
- **Recursive aggregation**: Inner Groth16 per batch → outer STARK (Plonky3) for final L1 verifier

---

## L1 Verification Contract (Soroban WASM)

### Responsibilities

1. **Proof verification**: Verify Groth16 proof on BN254 using Soroban's `bn254` host functions (`pairing_check`, `scalar_mul`, `hash_to_g1`, `hash_to_g2`)
2. **State root update**: On valid proof, write new L2 state root to contract storage
3. **Forced transaction inclusion**: L1 → L2 escape hatch; user submits tx to L1 contract; sequencer MUST include within N blocks or face slashing
4. **Fraud proof submission**: Invalid state transition challenge (L2 state root doesn't match execution trace)
5. **Validator set management**: Round-robin sequencer election, staking, slashing logic

### Gas Optimization: Recursive SNARKs

- **Inner layer**: One Groth16 proof per batch of ~100 txs (~30s generation, ~2k constraints/tx)
- **Outer layer**: Plonky3/STARK aggregates 10 inner proofs into one (~1min, recursive)
- **L1 verification**: Single Groth16 verification on BN254 (~200k gas) + 1-2 pairings
- **Estimated L1 gas per batch**: < 500k (target met)

---

## Bridge & Escape Hatch

| Direction | Mechanism | Challenge Period |
|-----------|-----------|------------------|
| **L1 → L2 Deposit** | Lock tokens in L1 bridge contract; Merkle proof of lock event → mint on L2 | None (finality on L1) |
| **L2 → L1 Withdrawal** | Burn on L2; emit withdrawal event in L2 Merkle tree; submit proof to L1 | **7 days** for fraud challenge |
| **Escape Hatch** | If sequencer censors / goes offline, user calls L1 `forceWithdraw(batchIndex, merkleProof)` | 7 days; if no valid L2 state root published, L1 allows exit from last known good root |

---

## Sequencer & Prover Network

### Sequencer (Decentralized, Round-Robin)

- **Leader election**: Stake-weighted VRF / round-robin among registered sequencers
- **Block time**: 2 seconds (L2); L1 batch submission every ~100 L2 blocks
- **Sequencer duties**: Order txs, execute in zkWASM, generate inner proof, submit to aggregator
- **Slashing**: Equivocation, liveness failure, invalid state root

### Prover Market

- **Permissionless**: Anyone can run a prover (GPU/FPGA accelerated)
- **Assignment**: Sequencer broadcasts batch + witness; provers race to generate inner proof
- **Reward**: Winning prover receives batch fees (L2 tx fees + L1 subsidy)
- **Hardware acceleration**: CUDA kernels for MSM/NTT; FPGA for Poseidon/Keccak

---

## Proof System Comparison: STARK vs SNARK

| Criterion | STARK (e.g., Plonky3, RISC Zero) | SNARK (Groth16 / PLONK on BN254) |
|-----------|----------------------------------|----------------------------------|
| **Proof size** | ~100-200 KB | ~200 bytes (Groth16) |
| **L1 verifier cost** | High (many hash constraints) | **Low** (1-2 pairings on BN254) |
| **Trusted setup** | **None** (transparent) | Required (Powers-of-Tau) |
| **Prover time (1k tx)** | ~10-20 min (recursive) | ~5-10 min (GPU MSM) |
| **Recursive aggregation** | Native (STARK→STARK) | Requires outer STARK or PLONK recursion |
| **Soroban host function support** | Generic (RISC Zero VM) | Requires BN254 precompile (partial) |
| **Maturity / audits** | Growing (RISC Zero, SP1 audited) | **High** (Groth16 in production since 2016) |
| **Quantum resistance** | Hash-based (yes) | Pairing-based (no) |

### Recommendation: Hybrid Approach

**Inner layer: Groth16 on BN254**
- Leverages Soroban's existing `bn254` host functions (see `src/api/bn254.ts`)
- Minimal L1 verification gas (~200k for pairing check)
- Mature tooling: `snarkjs`, `bellman`, `arkworks`

**Outer layer: Plonky3 STARK (recursive)**
- Aggregates 10-20 inner Groth16 proofs
- No additional trusted setup
- Fast verification in WASM (if needed for L2 light clients)

**Why not pure STARK?**
- L1 verifier gas would exceed 500k target (hash-heavy verification)
- Soroban lacks native Poseidon/Keccak precompiles; would need circuit emulation

**Why not pure PLONK?**
- Still requires trusted setup; larger proof than Groth16
- BN254 PLONK verifier heavier than Groth16

---

## Throughput Math (Acceptance Criteria)

| Metric | Target | Design Achieves |
|--------|--------|-----------------|
| **L2 throughput** | > 10,000 tx/s | 2s block × 5,000 tx/block = 10,000 tx/s (with 100 tx/batch, 50 batches/block) |
| **Proof generation (1k tx)** | < 30 min | 10 batches × 2 min GPU prover = 20 min (parallelizable to < 5 min) |
| **L1 verification gas** | < 500k | Groth16 pairing check: ~180k; state root update: ~50k; total ~250k |

---

## Explorer Integration (This Repository)

The `soroban-smart-block-backend` explorer backend now surfaces ZKP verification events indexed from L1:

- **`GET /api/v1/zkp-verifications/contracts/:address`** — history of proof verifications per contract
- **`GET /api/v1/zkp-verifications/transactions/:hash`** — ZKP events for a specific transaction
- **`GET /api/v1/zkp-verifications/proof-types/summary`** — aggregate counts by proof type (snark/stark/groth16)
- **`GET /api/v1/zkp-verifications/recent`** — most recent ZKP verifications across all contracts

Future L2-specific endpoints (blocks, contracts, debugger) will be added when the L2 node repository is live.

---

## Out of Scope for This Repository

This repository (`soroban-smart-block-backend`) is a **Soroban block explorer indexer + API**. The following components belong in a dedicated rollup-node repository (e.g., `soroban-zkrollup`):

| Component | Repository |
|-----------|------------|
| zkWASM circuit (Rust + Halo2 / Plonky3 / RISC Zero) | `soroban-zkrollup/circuits` |
| L1 Verifier Soroban contract (Rust) | `soroban-zkrollup/contracts/l1-verifier` |
| Sequencer node (Go/Rust) | `soroban-zkrollup/sequencer` |
| Prover network (GPU/FPGA) | `soroban-zkrollup/prover` |
| Bridge contracts (L1 + L2) | `soroban-zkrollup/contracts/bridge` |
| L2 explorer frontend | `soroban-zkrollup/explorer-frontend` |

---

## Appendix: L2 Debugger Requirements (Future)

When the L2 node is operational, the debugger should support:
- Step-through execution trace per transaction (WASM instruction level)
- Storage read/write diff with Merkle proof visualization
- Host function call stack with gas consumption
- Cross-contract call graph with depth tracking
- Time-travel: replay any historical L2 block with full trace

---

*Design document version 1.0 — aligned with `soroban-smart-block-backend` explorer integration.*