# @soroban-explorer/mobile

Cross-platform TypeScript SDK for the Soroban Smart Block Explorer, targeting React Native, Flutter (via FFI), and web (PWA).

See [DESIGN.md](./DESIGN.md) for the full architecture document.

## Install

```bash
npm install @soroban-explorer/mobile
```

## Usage

```ts
import { SorobanExplorerClient, SorobanExplorerFeed, SorobanExplorerAuth } from '@soroban-explorer/mobile';

const client = new SorobanExplorerClient({ baseUrl: 'https://api.soroban.network' });

const txs = await client.getTransactions({ page: 1, limit: 20 });
console.log(txs.data);
```

Platform-specific capabilities (secure storage, biometrics, push, SQLite, battery/network status) are injected via provider interfaces, keeping the SDK itself platform-agnostic.

## License

MIT
