/**
 * Quickstart — a working call in under five minutes.
 *
 *   SOROBAN_API_URL=http://localhost:3000/api/v1 npx ts-node examples/quickstart.ts
 *
 * Runs in CI against a real API instance (docker compose / CI service).
 */
import { SorobanClient, NotFoundError, RateLimitError } from '../src';

async function main(): Promise<void> {
  const client = new SorobanClient({
    baseUrl: process.env.SOROBAN_API_URL ?? 'http://localhost:3000/api/v1',
    apiKey: process.env.SOROBAN_API_KEY,
  });

  // Curated method
  const page = await client.transactions.list({ limit: 5 });
  console.log('transactions:', 'data' in page ? (page.data?.length ?? 0) : 0);

  // Any operation, fully typed from the OpenAPI spec
  const network = await client.call('getNetwork');
  console.log('network:', JSON.stringify(network).slice(0, 120));

  // Typed errors
  try {
    await client.transactions.get('0'.repeat(64));
  } catch (err) {
    if (err instanceof NotFoundError)
      console.log('not found as expected, requestId', err.requestId);
    else if (err instanceof RateLimitError)
      console.log('rate limited; retry after', err.retryAfterMs);
    else throw err;
  }

  // Pagination
  let n = 0;
  for await (const _tx of client.paginate(
    'getTransactions',
    { query: { limit: 2 } },
    { maxPages: 2 },
  ))
    n++;
  console.log('paginated items:', n);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
