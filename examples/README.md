# SDK example apps

Self-contained examples built on `@soroban-explorer/client`. Each reads `API_URL` (default `http://localhost:3000`).

| Example | Run | Description |
| --- | --- | --- |
| `bot/` | `npx ts-node examples/bot/index.ts` | Reads `score <addr>`, `badges <addr>`, `top` commands from stdin. |
| `dashboard/` | `npx ts-node examples/dashboard/index.ts` | Prints the reputation leaderboard. |
| `alerting/` | `ADDRESSES=G...,G... THRESHOLD=50 npx ts-node examples/alerting/index.ts` | Polls scores every minute and warns when below the threshold. |

Start the API first (`npm run dev`). The examples are sanity-tested in CI by `tests/examples/examples.test.ts`, which runs them against a stubbed fetcher.
