# Formal Verification System: Design Document

## 1. Overview

This document describes the formal verification system for Soroban smart contracts.
The system combines **symbolic execution**, **SMT-based model checking**, and **concolic testing**
to provide mathematical guarantees about contract behavior.

### 1.1 Architecture

```
User Spec (DSL)     Wasm Bytecode
       |                  |
       v                  v
  SpecCompiler      Wasm Decompiler
       |                  |
       v                  v
  SMT-LIB2          CFG + AST
       |                  |
       +--------+---------+
                |
                v
     SymbolicExecutionEngine
       (with CEGAR loop)
         |            |
         v            v
    SMT Solver    Concolic Executor
    (Z3/CVC5)        |
         |            |
         +-----+------+
               |
               v
       VulnerabilityReport
       + Exploit Witness
       + Safety Score
       + Gas Analysis
       + Badge Level
```

## 2. Formal Semantics of Soroban WASM

### 2.1 WASM Operational Semantics

We define a small-step operational semantics for the WASM subset relevant to
Soroban contracts. The state $\sigma$ is a tuple:

$$\sigma = \langle S, L, G, M, H, D \rangle$$

where:
- $S$: value stack ($\text{val}^*$)
- $L$: local variables ($\text{var} \to \text{val}$)
- $G$: global variables ($\text{global} \to \text{val}$)
- $M$: linear memory ($\text{addr} \to \text{byte}$)
- $H$: host function state (Soroban storage, balances, etc.)
- $D$: call depth counter

Values $v \in \text{val}$ are:
- $i32(n)$ for $n \in [0, 2^{32}-1]$
- $i64(n)$ for $n \in [0, 2^{64}-1]$
- $\text{addr}(a)$ for Stellar addresses ($a \in \{0,1\}^{256}$)

### 2.2 Instruction Semantics (Selected Rules)

**i32.add:**
$$\frac{S = v_2 :: v_1 :: S' \quad n_1 = \text{to_i32}(v_1) \quad n_2 = \text{to_i32}(v_2)}{\langle S, L, G, M, H, D \rangle \xrightarrow{\text{i32.add}} \langle i32((n_1 + n_2) \bmod 2^{32}) :: S', L, G, M, H, D \rangle}$$

**br_if $l$:**
$$
\frac{S = i32(0) :: S'}{\langle S, L, G, M, H, D \rangle \xrightarrow{\text{br\_if } l} \langle S', L, G, M, H, D \rangle[\text{pc} \to \text{label}(l)]}
$$
$$
\frac{S = i32(n) :: S' \quad n \neq 0}{\langle S, L, G, M, H, D \rangle \xrightarrow{\text{br\_if } l} \text{fallthrough}}
$$

**call $f$:**
$$\frac{}{\langle S, L, G, M, H, D \rangle \xrightarrow{\text{call } f} \langle S, L, G, M, H, D+1 \rangle[\text{pc} \to \text{entry}(f)]}$$

### 2.3 Soroban Host Function Semantics

**put_contract_data(key, val):**
$$
\frac{}{\langle \text{val} :: \text{key} :: S, L, G, M, H, D \rangle \xrightarrow{\text{put\_contract\_data}} \langle S, L, G, M, H[\text{storage} \to H.\text{storage}[k \mapsto v]], D \rangle}
$$

**get_contract_data(key):**
$$
\frac{H.\text{storage}[k] = v}{\langle \text{key} :: S, L, G, M, H, D \rangle \xrightarrow{\text{get\_contract\_data}} \langle v :: S, L, G, M, H, D \rangle}
$$
$$
\frac{H.\text{storage}[k] = \bot}{\langle \text{key} :: S, L, G, M, H, D \rangle \xrightarrow{\text{get\_contract\_data}} \langle \text{sym\_val} :: S, L, G, M, H, D \rangle}
$$

**call_contract(addr, fn, args):**
$$
\frac{}{\langle args :: fn :: addr :: S, L, G, M, H, D \rangle \xrightarrow{\text{call\_contract}} \langle S, L, G, M, H, D+1 \rangle} \quad \text{where } D < \text{MAX\_DEPTH}
$$

**require_auth(addr):**
$$
\frac{H.\text{auth}(addr)}{\langle addr :: S, L, G, M, H, D \rangle \xrightarrow{\text{require\_auth}} \langle S, L, G, M, H, D \rangle}
$$
$$
\frac{\neg H.\text{auth}(addr)}{\langle addr :: S, L, G, M, H, D \rangle \xrightarrow{\text{require\_auth}} \text{panic}}
$$

### 2.4 Soundness Theorem

**Theorem (Soundness of Symbolic Execution):**
For any WASM program $P$ and concrete initial state $\sigma_0$, if the symbolic
executor explores a path $\pi$ with path constraint $\phi_\pi$, and the SMT
solver determines $\phi_\pi$ is satisfiable with model $M$, then there exists
a concrete execution of $P$ following $\pi$.

*Proof sketch:* By induction on the length of the execution. The symbolic
semantics conservatively approximates the concrete semantics: each symbolic
transition subsumes all concrete transitions that satisfy the current path
constraint. The SMT solver's model provides a concrete assignment to all
symbolic variables, which can be used to construct the concrete execution.

### 2.5 Completeness (Bounded)

**Theorem (Bounded Completeness):**
For any WASM program $P$ and bound $k$ on loop unrolling and call depth,
the symbolic executor will explore all concrete executions of $P$ within
those bounds.

*Proof sketch:* The executor performs a systematic search of the program's
control-flow graph up to depth $k$. All branches are forked and both paths
are explored. The SMT solver checks path feasibility, so infeasible paths
are pruned but no feasible path is missed.

## 3. Specification Language Formal Semantics

### 3.1 Syntax

The DSL is a many-sorted first-order logic with bit-vectors:

$$\phi := v \mid c \mid \phi_1 \bowtie \phi_2 \mid \neg\phi \mid \phi_1 \wedge \phi_2 \mid \forall x:s.\ \phi \mid \exists x:s.\ \phi \mid \text{ite}(\phi, \phi_1, \phi_2)$$

Sorts: $\text{Bool}, \text{BitVec}[n], \text{Address}, \text{Array}[\text{BitVec}[256], \text{BitVec}[256]]$

### 3.2 Property Kinds

**Invariant** $I$: $\forall \sigma.\ \text{reachable}(\sigma) \implies I(\sigma)$

**Precondition** $P$ for function $f$: $\forall \sigma.\ \text{entry}_f(\sigma) \implies P(\sigma)$

**Postcondition** $Q$ for function $f$: $\forall \sigma, \sigma'.\ \text{trans}_f(\sigma, \sigma') \implies Q(\sigma, \sigma')$

**Temporal property** $T$: $\forall \pi.\ \text{execution}(\pi) \implies \square \lozenge T(\pi)$
(encoded via bounded model checking for finite traces)

### 3.3 Translation to SMT-LIB2

The spec compiler translates each property $\phi$ into SMT-LIB2 formulas:

- Sort `Int` → `(_ BitVec 256)` (unsigned 256-bit arithmetic)
- Sort `Bool` → `Bool`
- Quantifiers → `forall`/`exists`
- Array operations → `select`/`store`

Each property is asserted with a :named annotation for unsat core extraction.

## 4. CEGAR-Based Abstraction Refinement

### 4.1 Algorithm

The symbolic executor uses Counterexample-Guided Abstraction Refinement (CEGAR)
to mitigate path explosion:

```
1. Abstract: Build a control-flow automaton (CFA) from the WASM bytecode
2. Initial abstraction: Merge all variables into a single abstract state
3. Symbolic explore: Execute abstract paths through the CFA
4. Check: For each path, query SMT solver for feasibility
5. If feasible: Check for property violation
   a. If violation: Produce concrete witness, report vulnerability
   b. If no violation: Path is safe, refine abstraction
6. If infeasible: Path is spurious, refine abstraction
7. Refine: Add predicates to distinguish merged states
8. Re-explore with refined abstraction
```

### 4.2 Predicate Discovery

Predicates are discovered via:
1. **Branch conditions**: All boolean conditions in br_if/select instructions
2. **Interpolants**: From infeasible paths, compute interpolants using Craig interpolation
3. **User-specified**: From invariant annotations in the specification

The set of tracked predicates $P$ grows monotonically: $P_i \subseteq P_{i+1}$.

### 4.3 Convergence

**Theorem (CEGAR Convergence):**
For a program with finite state space (bounded by bit-width), the CEGAR loop
terminates after finitely many refinements.

*Proof:* The state space is finite ($2^{32}$ or $2^{64}$ values per variable).
Each refinement adds at least one new predicate, distinguishing at least one
pair of previously merged states. Since there are finitely many predicates
expressible over finite-width bit-vectors, the process terminates.

## 5. Loop Invariant Inference

### 5.1 Constraint-Based Invariant Inference

For loops with symbolic bounds, we use constraint-based invariant inference:

1. **Template**: Pre-define invariant templates (linear inequalities, octagons, etc.)
2. **Houdini algorithm**: Seed with candidate invariants, verify with SMT, remove invalid
3. **Interpolation**: Compute loop invariants from infeasible path interpolants

### 5.2 Invariant Template

For a loop with induction variable $i$ and modified variables $\vec{v}$:

$$\text{Inv}(i, \vec{v}) = \bigwedge_j (a_{j,0} + a_{j,1}i + \sum_k a_{j,k+1} v_k \geq 0)$$

Coefficients $a_{j,k}$ are existentially quantified and solved via SMT.

### 5.3 Soundness

**Theorem (Invariant Soundness):**
If the SMT solver proves that $\text{Inv}$ holds on loop entry, is preserved by
each iteration, and implies the desired property, then $\text{Inv}$ is a valid
loop invariant.

## 6. Path Explosion Mitigation Strategies

### 6.1 Abstraction Refinement (CEGAR)
As described in Section 4. Each refinement adds predicates to distinguish
abstract states, reducing spurious paths exponentially.

### 6.2 Loop Invariant Inference
As described in Section 5. Replaces $k$ unrollings with a single invariant check,
reducing $2^k$ paths to 1.

### 6.3 Concolic Testing
Combines concrete and symbolic execution:
1. Run with concrete inputs to collect path constraints
2. Negate one constraint at a time to explore new paths
3. Use SMT solver to generate concrete inputs for each new path

This provides depth-first coverage with runtime feedback, avoiding symbolic
divergence on complex computations.

### 6.4 Path Merging
At join points (after if-else), merge convergent paths using:
$$\text{merge}(s_1, s_2) = \text{ite}(\phi_1, s_1, s_2) \text{ where } \phi_1 \text{ is the branch condition}$$
This trades precision for scalability by keeping a single state per program point.

## 7. SMT Solver Integration

### 7.1 Bit-Precise WASM Semantics

All WASM operations are modeled as bit-vector operations in SMT-LIB2:

| WASM Op | SMT Encoding |
|---------|-------------|
| `i32.add` | `(bvadd x y)` |
| `i32.sub` | `(bvsub x y)` |
| `i32.mul` | `(bvmul x y)` |
| `i32.div_s` | `(bvsdiv x y)` |
| `i32.rem_s` | `(bvsrem x y)` |
| `i32.eq` | `(= x y)` |
| `i32.lt_s` | `(bvslt x y)` |

### 7.2 Incremental Solving

Properties are checked incrementally:
1. Push scope with `(push 1)`
2. Assert property negation
3. Check satisfiability
4. Pop scope with `(pop 1)`
5. Continue to next property

This avoids re-parsing and re-asserting shared constraints.

### 7.3 Distributed Solving

Independent symbolic paths are distributed across a pool of solver processes:

```
┌─────────────┐   Path 1 ──→ Solver Worker 1
│  Symbolic    │   Path 2 ──→ Solver Worker 2
│  Executor    │   Path 3 ──→ Solver Worker 3
│  (Path Gen)  │   ...         ...
└─────────────┘   Path N ──→ Solver Worker K
```

Each worker is a separate OS process with its own Z3/CVC5 instance.
Results are collected and merged by the main process.

## 8. Vulnerability Detection

### 8.1 Integer Overflow/Underflow

For operation $\text{op}(a, b)$ with result $r$:
- **Overflow (signed)**: $\text{OV}_s(a, b, r) = r \neq \text{to\_signed}(\text{to\_signed}(a)\ \text{op}\ \text{to\_signed}(b))$
- **Underflow**: $\text{UF}(a, b) = a < b$ for subtraction

The solver checks satisfiability of $\text{PC} \land (\text{OV} \lor \text{UF})$.

### 8.2 Division by Zero

For operation $\text{div}(a, b)$: Solver checks $\text{PC} \land (b = 0)$.

### 8.3 Reentrancy

For a call graph $G = (V, E)$ where $V$ is contract addresses and $E$ is call edges:
- **Direct reentrancy**: Cycle of length 2 ($A \to B \to A$)
- **Indirect reentrancy**: Cycle of length $n$ ($A \to C_1 \to \ldots \to C_n \to A$)
- **Read-only reentrancy**: Reentrant call that only reads state (cross-contract)

The analyzer detects all cycles in the call graph using DFS and classifies severity
by cycle length.

### 8.4 Concrete Exploit Trace Generation

For each violated property, the SMT solver's model provides concrete values
for all symbolic variables. The trace generator:

1. Extracts the model from solver output
2. Converts bit-vector values to concrete integers
3. Maps each SMT variable to the corresponding WASM local/global
4. Replays the execution with concrete values to produce step-by-step trace
5. Constructs a human-readable exploit scenario

## 9. Gas Usage Verification

Gas cost is modeled as a linear function of instruction count, memory usage,
and ledger operations:

$$\text{Gas}_{\text{total}} = \sum_{i \in \text{path}} (c_{\text{cpu}}(i) + c_{\text{mem}}(i)) + \sum_{h \in \text{host\_calls}} \text{Gas}_{\text{host}}(h)$$

For symbolic analysis, worst-case gas is computed by finding the path that
maximizes gas consumption, formulated as an optimization query to the SMT solver:

$$\text{maximize Gas}_{\text{total}} \text{ subject to PC}_{\text{path}}$$

## 10. CI Integration Pipeline

```
┌─────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ Deploy  │───→│ Extract CFG  │───→│ Run Verifier  │───→│ Publish  │
│ Contract │    │ from Wasm    │    │ + SMT Solve  │    │ Report   │
└─────────┘    └──────────────┘    └──────────────┘    └──────────┘
                                        │
                                        v
                                  ┌──────────┐
                                  │ Badge     │
                                  │ Update    │
                                  └──────────┘
```

## 11. Integration with Existing Sandbox

The sandbox runtime (`src/sandbox/runtime.ts`) already imports the verifier.
The integration flow is:

1. **Deploy in sandbox** → captures Wasm bytecode + ABI
2. **Extract CFG** → wasm-decompiler produces `WasmFunction[]`
3. **Load specs** → user provides specification or auto-generates from ABI
4. **Run verifier** → symbolic execution + SMT solving
5. **Display results** → vulnerability report, safety score, badge

## 12. Acceptability Criteria

| Criterion | Approach |
|-----------|----------|
| Medium contract (5 functions, 200 lines) < 10 min | CEGAR + concolic testing limits paths; distributed solving across 4 workers |
| Reentrancy detection, 0 false positives, top 100 contracts | Sound call graph analysis + SMT feasibility checking eliminates spurious cycles |
| Specification expresses all common security properties | DSL supports invariants, pre/post, temporal, quantifiers, arrays |
| CI pipeline < 30 min | Incremental solving, path caching, parallel property checking |

## 13. Soundness Proofs

### 13.1 Symbolic Execution Soundness

**Theorem:** Let $P$ be a WASM program and $\sigma_0$ an initial concrete state.
If the symbolic executor reports a vulnerability of type $T$ at program point
$l$ with path constraint $\phi$, then there exists a concrete input $I$ such
that executing $P$ with $I$ from $\sigma_0$ reaches $l$ and exhibits
vulnerability $T$.

*Proof:* By construction:
1. Each symbolic transition subsumes all concrete transitions consistent with
   the path constraint (the symbolic semantics is a sound abstraction).
2. The SMT solver produces model $M \models \phi$ if $\phi$ is satisfiable.
3. $M$ assigns concrete values to all symbolic inputs.
4. Replaying execution with these concrete values follows path $\pi$,
   reaching $l$ with vulnerability $T$.

### 13.2 Reentrancy Analysis Soundness

**Theorem:** If the reentrancy analyzer reports no vulnerabilities, there is
no feasible reentrant call sequence of depth $\leq k$ (where $k$ is the
analysis bound).

*Proof:* The analyzer explores all call sequences up to depth $k$ via the
call graph. Each edge $A \to B$ is checked for SMT feasibility:
$\text{PC}_A \land \text{call\_condition}(A,B) \land \text{entry}_{B}$.
If no cycle of length $\leq k$ is feasible, no reentrancy of depth $\leq k$
exists.

### 13.3 Spec Verification Soundness

**Theorem:** If the verifier returns `verified` for property $\phi$, then all
concrete executions of the contract (within bounded unrolling) satisfy $\phi$.

*Proof:* Let $\text{PC}_\pi$ be the path constraint for path $\pi$. The verifier
checks $\bigwedge_{\pi \in \text{paths}} \text{PC}_\pi \implies \phi$. If the
SMT solver proves this formula unsatisfiable for all paths, then every concrete
execution (which must follow some path $\pi$ and satisfy $\text{PC}_\pi$)
must also satisfy $\phi$.

## 14. Threat Model

### 14.1 Adversarial Capabilities
- An adversary can deploy arbitrary WASM bytecode
- An adversary can invoke any public function with arbitrary parameters
- An adversary can deploy malicious contracts that interact with verified contracts
- An adversary can reorder transactions (within the same ledger)

### 14.2 Assumptions
- The underlying Stellar/Soroban consensus is correct
- The SMT solver (Z3/CVC5) is correct
- The WASM decompiler correctly interprets bytecode
- Cryptographic primitives (ed25519, SHA-256) are secure

### 14.3 Guarantees
- No false negatives for assertion violations on explored paths
- No false negatives for integer overflow/underflow on explored paths
- No false negatives for reentrancy up to depth bound
- Gas estimates are upper bounds on actual consumption
