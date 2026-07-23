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

## Async Error Handling — `asyncHandler`

All async Express route handlers **must** be wrapped with `asyncHandler` from
`src/middleware/asyncHandler.ts`. This forwards any unhandled promise rejection
to the global error handler automatically so you never forget a `try/catch`.

**❌ Don't do this:**
```ts
router.get('/foo', async (req, res, next) => {
  try {
    const data = await fetchData();
    res.json(data);
  } catch (err) {
    next(err);
  }
});
```

**✅ Do this instead:**
```ts
import { asyncHandler } from '../middleware/asyncHandler';

router.get('/foo', asyncHandler(async (req, res) => {
  const data = await fetchData();
  res.json(data);
}));
```

The `lint:error-handling` script (`npm run lint:error-handling`) enforces this
rule via the local `eslint-plugin-error-handling` and runs in CI.

### Migrating an existing handler

1. Add `import { asyncHandler } from '../middleware/asyncHandler';` at the top.
2. Replace `async (req, res) => { try { ... } catch (e) { next(e); } }` with
   `asyncHandler(async (req, res) => { ... })`.
3. Remove the surrounding `try/catch` — errors are caught for you.

## Structured Logging

Use the shared `logger` from `src/logger.ts` instead of `console.*`.

```ts
import { logger } from '../logger';

logger.info('contract indexed', { address, duration_ms: elapsed });
logger.warn('rpc timeout', { url, attempt });
logger.error('db write failed', { model: 'Transaction', error: String(err) });
logger.debug('cache hit', { key });
```

- In **development** logs are pretty-printed; in **production** they are JSON.
- Log level is controlled by the `LOG_LEVEL` env var (`debug | info | warn | error`).
- Each request automatically includes `requestId` and `duration_ms` via the
  `requestLoggerMiddleware` in `src/logger.ts`.
- Keep `console.error` only in `src/index.ts` as a last-resort startup fallback.

## Database Index Strategy

Every foreign-key field (fields ending in `Id`) **must** have a corresponding
`@@index` or `@@unique` in the Prisma schema. Without an index, any JOIN or
filter on that field causes a full table scan as data grows.

**Rule:** when you add a new FK field, also add `@@index([fieldName])` to the
same model block.

```prisma
model MyModel {
  id         String @id @default(cuid())
  parentId   String          // FK

  parent Parent @relation(fields: [parentId], references: [id])

  @@index([parentId])        // ← required
}
```

Run `npm run audit:indexes` locally before opening a PR. CI will fail if any
FK field lacks an index.

## Freeze Management System Architecture

The Soroban Smart Block Explorer includes a robust CAP-0077 Consensus Asset-Freeze transaction interceptor and management system:
- **`FrozenLedgerKey` Model**: Maintains a registry of currently frozen ledger keys.
- **`FreezeViolation` Model**: Records transactions that touched frozen keys, along with a severity level (`low`, `medium`, `high`, `critical`).
- **`AuditLog` Model**: Stores an immutable event log for all freeze-related state changes (freezing, thawing, resolving violations).
- **Scanner (`src/indexer/freeze-scanner.ts`)**: In real-time, extracts the read/write footprint of transactions and checks against the in-memory cache of frozen keys. Critical violations trigger webhooks.
- **API (`src/api/freeze.ts`)**: Provides complete CRUD and aggregation operations for keys, violations, and audit logs.

## Questions?

Open a GitHub Discussion or ask in the [Stellar Discord](https://discord.gg/stellardev).
