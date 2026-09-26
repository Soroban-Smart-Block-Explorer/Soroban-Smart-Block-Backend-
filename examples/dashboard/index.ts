import { ReputationClient } from '../../packages/client/src';

/** Dashboard: renders the reputation leaderboard as a plain-text table. */
export async function renderLeaderboard(client: ReputationClient, category = 'overall'): Promise<string> {
  const data = (await client.leaderboard(category, 10)) as { entries?: Array<{ address: string; score: number }> };
  const rows = (data.entries ?? []).map((e, i) => `${String(i + 1).padStart(2)}. ${e.address}  ${e.score}`);
  return [`Leaderboard: ${category}`, ...rows].join('\n');
}

if (require.main === module) {
  const client = new ReputationClient({ baseUrl: process.env.API_URL ?? 'http://localhost:3000' });
  renderLeaderboard(client).then(console.log);
}
