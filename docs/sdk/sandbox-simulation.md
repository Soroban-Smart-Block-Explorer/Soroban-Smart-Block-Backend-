# Sandbox simulation via the SDK

`SandboxClient` (`packages/client/src/sandbox.ts`) exposes contract simulation as a typed call.

## Request schema

`{ transaction: string }` - base64 XDR transaction envelope. Validated client-side before any network call.

## Semantics

- `simulate()` posts to `POST /api/v1/simulate` (API key required, sent as `x-api-key`).
- The result always carries `success`, which is true iff the server returned no `error`.
- HTTP failures throw `SandboxSimulationError` with the HTTP `status`.
- Simulation is deterministic for a given transaction and ledger state.

## Example test scenarios

```ts
import { SandboxClient } from '@soroban-explorer/client';

const client = new SandboxClient({ baseUrl: 'http://localhost:3000', apiKey: process.env.API_KEY });
const outcomes = await client.runScenarios([
  { name: 'valid transfer succeeds', request: { transaction: 'AAAAAgAAAAB...' }, expectSuccess: true },
  { name: 'bad auth fails', request: { transaction: 'AAAAAgAAAAC...' }, expectSuccess: false, expectErrorIncludes: 'auth' },
]);
console.table(outcomes.map(({ name, passed, reason }) => ({ name, passed, reason })));
```
