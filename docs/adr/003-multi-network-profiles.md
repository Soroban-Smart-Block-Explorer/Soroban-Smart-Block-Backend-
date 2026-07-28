# ADR-003: Multi-Network Profile System

## Status
Accepted

## Context
Soroban networks have different RPC endpoints, passphrases, and database schemas. A single hard-coded configuration makes local development and multi-network deployments error-prone.

## Decision
Model every network as a first-class profile with its own:
- Database connection (`*_DATABASE_URL`, `*_READ_REPLICA_URL`)
- RPC / Horizon endpoints
- Cache URL
- API subdomain
- Network passphrase

The active profile is selected via `STELLAR_NETWORK=testnet|mainnet|devnet` at startup. All network-specific config is loaded from matching env vars.

## Consequences
- Running testnet + mainnet side-by-side is trivial
- Reduces accidental cross-network config leaks
- Adds startup validation to fail fast on missing env vars
