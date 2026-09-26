# Developer tutorial series

Work through these in order. Each tutorial links to a runnable script in `docs/tutorials/examples/`.

| # | Tutorial | Example script |
|---|----------|----------------|
| 1 | [Get started](01-get-started.md) | `examples/01-get-started.mjs` |
| 2 | [Search](02-search.md) | `examples/02-search.mjs` |
| 3 | [Realtime](03-realtime.md) | `examples/03-realtime.mjs` |
| 4 | [Exports](04-exports.md) | `examples/04-exports.mjs` |
| 5 | [Alerts](05-alerts.md) | `examples/05-alerts.mjs` |

Run an example with `BASE_URL=http://localhost:3000 node docs/tutorials/examples/01-get-started.mjs`.
The table of contents is checked by `node scripts/check-tutorial-links.mjs` (relative links and TOC completeness).
When adding a tutorial, add its row above and its script under `examples/`.
See also the SDK in `packages/client` and [CONTRIBUTING.md](../../CONTRIBUTING.md).
