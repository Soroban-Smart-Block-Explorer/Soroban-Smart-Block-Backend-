import { ReputationClient } from '../../packages/client/src';

export interface AlertOptions {
  addresses: string[];
  threshold: number;
  notify: (message: string) => void | Promise<void>;
}

/** Alerting hook: calls notify() for each address whose score is below threshold. */
export async function checkScores(client: ReputationClient, opts: AlertOptions): Promise<number> {
  let alerts = 0;
  for (const address of opts.addresses) {
    const result = (await client.score(address)) as { score?: number };
    if (typeof result.score === 'number' && result.score < opts.threshold) {
      alerts += 1;
      await opts.notify(`ALERT ${address}: score ${result.score} < ${opts.threshold}`);
    }
  }
  return alerts;
}

if (require.main === module) {
  const client = new ReputationClient({ baseUrl: process.env.API_URL ?? 'http://localhost:3000' });
  const addresses = (process.env.ADDRESSES ?? '').split(',').filter(Boolean);
  setInterval(() => {
    void checkScores(client, { addresses, threshold: Number(process.env.THRESHOLD ?? 50), notify: console.warn });
  }, 60_000);
}
