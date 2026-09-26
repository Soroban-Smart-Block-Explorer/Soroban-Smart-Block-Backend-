import { ReputationClient } from '../../packages/client/src';

/** Reputation bot: answers "score <address>" style commands using the SDK. */
export async function handleCommand(client: ReputationClient, text: string): Promise<string> {
  const [cmd, arg] = text.trim().split(/\s+/);
  if (cmd === 'score' && arg) return JSON.stringify(await client.score(arg));
  if (cmd === 'badges' && arg) return JSON.stringify(await client.badges(arg));
  if (cmd === 'top') return JSON.stringify(await client.leaderboard('overall', 5));
  return 'Usage: score <address> | badges <address> | top';
}

if (require.main === module) {
  const client = new ReputationClient({ baseUrl: process.env.API_URL ?? 'http://localhost:3000' });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (line: string) => {
    console.log(await handleCommand(client, line));
  });
}
