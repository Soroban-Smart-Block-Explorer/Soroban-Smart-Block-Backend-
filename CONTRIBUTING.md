# Contributing to Soroban Smart Block Explorer

Thanks for your interest in contributing! This project is part of the **Stellar Wave Program** on [Drips](https://www.drips.network/wave/stellar).

## Local Setup

### Prerequisites
- Node.js 20+
- PostgreSQL 16+ (or Docker)
- Git

### Steps

```bash
git clone https://github.com/<your-org>/soroban-block-explorer-backend
cd soroban-block-explorer-backend

cp .env.example .env
# Edit .env — at minimum set DATABASE_URL

npm install
npx prisma migrate dev --name init
npm run dev
```

With Docker (no local Postgres needed):
```bash
cp .env.example .env
docker compose up db -d        # start only the DB
npx prisma migrate dev --name init
npm run dev
```

### Running the indexer (separate terminal)
```bash
npm run index
```

### Running tests
```bash
npm test
```

## Project Structure

```
src/
├── api/          # Express route handlers
├── indexer/      # Soroban RPC polling + XDR decoder
├── config.ts     # Env config
├── db.ts         # Prisma client
└── index.ts      # App entry point
prisma/
├── schema.prisma # DB schema
└── seed.ts       # Known contract seed data
```

## How to Contribute

1. Find an open issue labeled `Stellar Wave` or `good first issue`.
2. Comment on the issue or apply via the Drips Wave app.
3. Fork the repo, create a branch: `git checkout -b fix/your-issue`.
4. Make your changes. Add or update tests where relevant.
5. Run `npm test` and ensure all tests pass.
6. Open a Pull Request against `main`. Reference the issue number.

## Code Style

- TypeScript strict mode is enabled — no `any` unless unavoidable.
- Keep functions small and focused.
- Add a comment if the logic isn't obvious.

## Freeze Management System Architecture

The Soroban Smart Block Explorer includes a robust CAP-0077 Consensus Asset-Freeze transaction interceptor and management system:
- **`FrozenLedgerKey` Model**: Maintains a registry of currently frozen ledger keys.
- **`FreezeViolation` Model**: Records transactions that touched frozen keys, along with a severity level (`low`, `medium`, `high`, `critical`).
- **`AuditLog` Model**: Stores an immutable event log for all freeze-related state changes (freezing, thawing, resolving violations).
- **Scanner (`src/indexer/freeze-scanner.ts`)**: In real-time, extracts the read/write footprint of transactions and checks against the in-memory cache of frozen keys. Critical violations trigger webhooks.
- **API (`src/api/freeze.ts`)**: Provides complete CRUD and aggregation operations for keys, violations, and audit logs.

## Questions?

Open a GitHub Discussion or ask in the [Stellar Discord](https://discord.gg/stellardev).
