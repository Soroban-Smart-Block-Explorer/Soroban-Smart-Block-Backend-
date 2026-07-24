# Sandbox Fuzzing Architecture

## Overview
The sandbox now exposes a lightweight coverage-guided fuzzing campaign engine for Soroban-style contracts running inside the in-memory sandbox runtime. Campaigns mutate contract call arguments, storage state, and simple oracle-style feed values while tracking branch coverage and invariant violations.

## Components
- Sandbox runtime: executes contract-like template operations and records state transitions.
- Fuzz campaign engine: builds multi-step call sequences from a seed corpus and mutates them across worker lanes.
- Invariant engine: evaluates simple state properties such as totalSupply == sum(balances) after each step.
- Crash triage: deduplicates findings by a fingerprint derived from severity, function name, and coverage signature, then minimizes the step list.

## Mutation Strategy
1. Seed corpus entries provide the initial call shapes.
2. Each step mutates arguments using bounded, Soroban-friendly values (for example, negative or boundary-like amounts for token flows).
3. Storage and oracle feed values are mutated between steps to simulate state drift and price-feed manipulation.
4. Branch coverage is approximated from a small set of observable branches such as function, success, and state-change outcomes.

## Campaign API
- POST /api/v1/sandbox/fuzz/{contract_id}
- GET /api/v1/sandbox/fuzz/{campaign_id}
- GET /api/v1/sandbox/fuzz/{campaign_id}/crashes
- POST /api/v1/sandbox/fuzz/{campaign_id}/minimize/{crash_id}

## Future Extensions
- Full WASM instrumentation for real basic-block coverage.
- Distributed fan-out across many sandbox workers.
- Deterministic replay and bug-bounty submission integration.
