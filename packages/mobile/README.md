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

### Offline persistence

`SorobanExplorerLocalCache` persists recent searches, the active watchlist, and last-viewed entities on-device so the app stays usable offline or on flaky networks. It takes an injected key-value storage provider (`AsyncStorage`, MMKV, `localStorage`, …) and is the source of truth while offline:

```ts
import { SorobanExplorerClient, SorobanExplorerLocalCache } from '@soroban-explorer/mobile';

const cache = new SorobanExplorerLocalCache(storageProvider);
await cache.initialize();

await cache.recordSearch('usdc', 12);
await cache.toggleWatchlist({ type: 'contract', id: 'C...' }, 'USD Coin');
await cache.recordView({ type: 'wallet', id: 'G...' }, 'Main wallet');

// Enrich the persisted entries with small server summaries when online.
const client = new SorobanExplorerClient({ baseUrl: 'https://api.soroban.network' });
await cache.hydrate((refs) => client.getHydrationEntities(refs));
```

## License

MIT
