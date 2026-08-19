# @soroban-explorer/client

TypeScript/JavaScript client for the Soroban Smart Block Explorer API.

## Install

```bash
npm install @soroban-explorer/client
# or
yarn add @soroban-explorer/client
# or
pnpm add @soroban-explorer/client
```

## Usage

### Real-time feed

```ts
import { SorobanFeed } from '@soroban-explorer/client';

const feed = new SorobanFeed({ apiKey: 'my-key' });

const sub = await feed.subscribe({
  channelName: 'trades',
  filters: { pools: ['C...'] },
  deliveryType: 'webhook',
  deliveryConfig: {
    url: 'https://api.mysystem.com/soroban-feed',
    headers: { Authorization: 'Bearer my-token' },
    batchSize: 100,
  },
});
```

### Reputation

```ts
import { ReputationClient } from '@soroban-explorer/client';

const reputation = new ReputationClient({ baseUrl: 'https://api.soroban.network' });
const score = await reputation.score('G...');
```

## License

MIT
