# ADR-001: Dual Prisma Client Pattern

## Status
Accepted

## Context
The application serves multiple Stellar networks (testnet, mainnet, devnet), each with its own PostgreSQL database. A single Prisma client cannot safely multiplex connections across databases at runtime, and creating clients per-request is expensive.

## Decision
Use two dedicated Prisma clients:
- `prismaRead` — points to the read replica / primary DB for queries
- `prismaWrite` — points to the primary DB for mutations

Each client is instantiated once at startup from environment-specific `DATABASE_URL` and `READ_REPLICA_URL` values.

## Consequences
- Clear separation of read vs write traffic
- Enables future read-replica scaling without route-handler changes
- Prevents accidental writes through the read client (lint rule enforces this)
