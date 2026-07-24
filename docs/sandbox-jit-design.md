# High-Performance WASM JIT Sandbox Design

**Status**: Design document only. Implementation not started. See [Follow-ups](#follow-ups).

---

## 1. JIT Architecture

### 1.1 Target Platforms
- x86-64 (Intel/AMD, Linux/macOS/Windows)
- ARM64 (Apple Silicon, AWS Graviton, Raspberry Pi 4+)

### 1.2 Tiered Compilation Pipeline

| Tier | Description | Optimization Level | Use Case |
|------|-------------|-------------------|----------|
| Interpreter | Bytecode walker, no code gen | None | Cold paths, code never JITed, fallback when budget exhausted |
| Baseline (Cranelift) | Single-pass, block-level, no register alloc | -O0 equivalent | First execution of hot functions; fast compile (<1ms) |
| Optimizing (Cranelift) | Full SSA, register alloc, inlining, GVN, LICM, const folding | -O2/-O3 equivalent | Functions exceeding hot-count threshold; OSR entry |

### 1.3 On-Stack Replacement (OSR)
- **Trigger**: Loop header back-edge counter exceeds threshold (configurable, default 10,000)
- **Mechanism**: Baseline frame patched with OSR entry stub; optimizing compiler emits specialized OSR entry block mapping live SSA values to baseline frame slots
- **Deoptimization**: Bailout to baseline on trap / guard failure; state reconstructed via debug info

### 1.4 Fallback Interpreter
- Used when: JIT compilation budget exceeded per-session (configurable, default 50ms cumulative), or module contains unsupported WASM features (threads, SIMD, exceptions)
- Shares gas-metering hooks with JIT tiers

### 1.5 Module Caching
- Compiled artifacts cached keyed by `(wasm_hash, target_triple, cranelift_flags)`
- Persistent on-disk cache (content-addressed) survives process restarts
- Warm cache hits skip baseline entirely → direct to optimizing tier

---

## 2. Gas Metering Algorithm

### 2.1 Cost Model Structure

```typescript
interface GasCostTable {
  cpu: {
    arith: 1;      // i32.add, i64.add, etc.
    logic: 1;      // i32.and, i64.or, etc.
    control: 2;    // br, br_if, br_table
    div: 5;        // i32.div_s, i64.div_u, etc.
    mul: 3;        // i32.mul, i64.mul
    rem: 5;        // i32.rem_s, i64.rem_u
  };
  memory: {
    read_per_byte: 1;
    write_per_byte: 2;
    grow_per_page: 100;  // 64 KiB page
  };
  host: Record<HostFunction, number>;  // e.g., "get_contract_data" -> 300
}
```

### 2.2 Metering Hooks

- **Per-instruction**: Injected at baseline compile time via Cranelift `FuncEnvironment::instrument` (adds `gas.consume(weight)` before each block)
- **Host functions**: Gas consumed in host shim before crossing WASM/host boundary
- **Memory ops**: `memory.grow` charged `cpu.memory.grow + bytes * memory.write_per_byte`; loads/stores charged per-byte with cache-hit discount tracked via per-instance access bitmap

### 2.3 Prepay / Refund Envelope

1. Before execution: `prepay = estimate_upper_bound(ops, host_calls, memory_estimate)`
2. During execution: `consume(actual)` decrements remaining
3. On trap / OOG: Execution halts, no refund
4. On success: `refund = prepay - consumed` credited to caller

Prepay estimation formula:
```
prepay = BASE_OVERHEAD
       + Σ(instr_count_estimate[op] * cost.cpu[op])
       + estimated_host_calls * cost.prepay.per_host_call
       + estimated_memory_bytes * cost.memory.write_per_byte
```

### 2.4 Introspection

Result payload includes:
```typescript
{
  cpu_by_function: Map<string, number>,
  host_by_function: Map<string, number>,
  memory_read_bytes: number,
  memory_write_bytes: number,
  prepay_charged: number,
  refund: number,
}
```

---

## 3. Deterministic Execution Engine

### 3.1 Non-Determinism Elimination

| Source | Mitigation |
|--------|------------|
| Floating-point (f32/f64) | Trap on any float op; reject modules using float at load time unless `--allow-float` (dev only) |
| `memory.grow` non-determinism | Deterministic: always succeeds up to configured max; OOG on limit |
| Wall clock / `time.now` | Not exposed to WASM; host provides deterministic ledger timestamp only |
| Random / entropy | Not exposed; contracts use deterministic PRNG seeded from ledger |
| Thread scheduling | Threads disabled (`--no-threads`); single-threaded execution only |
| JIT code layout | Cranelift `--deterministic` flag; fixed function ordering by hash; no profile-guided reorder |

### 3.2 Deterministic Gas
- Gas consumption is a pure function of the executed instruction trace
- No data-dependent branches in metering code (constant-time `consume`)
- Same trace → identical gas on any machine, any tier

### 3.3 Replay Oracle
Input: mainnet transaction hash → RPC fetch → decode `InvokeHostFunction` ops → execute in sandbox → compare:
- Events emitted (topic + data)
- Ledger entry reads/writes (key + value)
- Gas consumed per host function
- Final state root (if contract implements state commitment)

Target: < 10% of real execution time (i.e., < 50ms for typical 500ms mainnet tx)

---

## 4. State Isolation & Caching

### 4.1 Copy-on-Write Snapshots
- Each sandbox session forks a read-only base state (ledger snapshot at `ledgerSequence`)
- Writes recorded in per-session overlay map (`Map<LedgerKey, Option<Value>>`)
- Reads check overlay first, then base
- Snapshots serializable; can be cloned for parallel scenarios (fuzz, CI)

### 4.2 Warm Cache
- Frequently accessed ledger entries (top-N contracts by call volume) preloaded into in-memory LRU
- Configurable TTL, default 5 min

### 4.3 Persistent Cache
- Compiled WASM modules (per-tier artifacts) stored in content-addressed blob store
- State snapshots optionally persisted for fast session resume

---

## 5. Security Hardening

| Vector | Mitigation |
|--------|------------|
| Side-channel (timing) on gas | `consume` is constant-time; no data-dependent branches; host shims use fixed-time path |
| OOB memory access | WASM linear memory bounds checked by Cranelift-generated bounds checks; host memory never mapped into WASM address space |
| Resource exhaustion | Per-instance: max memory (default 10 MB), max fuel (configurable), max call depth (default 64), wall-time soft/hard kill |
| Spectre/Meltdown | `lfence` / speculation barrier between contract executions in same process; `wasmtime::Config::consume_fuel` + epoch interruption for preemption |
| Host function reentrancy | Reentrancy guard per host function; nested call traps |

---

## 6. Acceptance Criteria Mapping

| #561 Requirement | Status | Notes |
|------------------|--------|-------|
| JIT executes at ≥80% native Rust perf | **Not implemented** | Requires Cranelift integration + benchmarks |
| Gas matches mainnet within 1% on 1000 tx | **Not implemented** | Requires cost table calibration + replay corpus |
| Deterministic replay: same output on 3 machines | **Partially met (JS sim)** | Current JS simulator is deterministic; WASM tier not built |
| JIT cold-start < 5ms | **Not implemented** | Requires baseline compiler + cache warmup |
| Design doc with JIT arch + gas algo | **This document** | — |

---

## 7. Follow-Ups (Implementation Track)

1. **`feat: add wasmtime via napi-rs`** — Native addon build, per-arch wheels, CI matrix
2. **`feat: baseline compiler integration`** — Cranelift single-pass codegen, fuel metering hooks
3. **`feat: optimizing tier + OSR`** — Full SSA pipeline, hotness counters, OSR entry/exit
4. **`feat: gas cost model calibration`** — Replay 1000 mainnet tx, diff against mainnet gas, iterate weights
5. **`feat: replay oracle pipeline`** — RPC ingestion, XDR decode, parallel execution, comparison report
6. **`feat: side-channel hardening`** — Constant-time metering, lfence barriers, epoch preemption
7. **`docs: benchmark report`** — Publish perf numbers vs. soroban-env-host native

---

*Generated as part of issue #561 design phase. No implementation code in this repository yet.*