import { describe, it, expect, vi } from 'vitest';
import { ReputationClient } from '../../packages/client/src';
import { handleCommand } from '../../examples/bot';
import { renderLeaderboard } from '../../examples/dashboard';
import { checkScores } from '../../examples/alerting';

function clientReturning(body: unknown) {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, statusText: 'OK', json: async () => body });
  return { client: new ReputationClient({ baseUrl: 'http://x', fetcher }), fetcher };
}

describe('SDK example apps', () => {
  it('bot answers commands and prints usage', async () => {
    const { client, fetcher } = clientReturning({ score: 80 });
    expect(await handleCommand(client, 'score GABC')).toContain('80');
    expect(fetcher).toHaveBeenCalledWith('http://x/api/v1/reputation/score/GABC', expect.anything());
    expect(await handleCommand(client, 'nope')).toContain('Usage');
  });

  it('dashboard renders leaderboard rows', async () => {
    const { client } = clientReturning({ entries: [{ address: 'GA', score: 9 }] });
    expect(await renderLeaderboard(client)).toContain(' 1. GA  9');
  });

  it('alerting notifies for scores below threshold', async () => {
    const { client } = clientReturning({ score: 10 });
    const notify = vi.fn();
    expect(await checkScores(client, { addresses: ['GA'], threshold: 50, notify })).toBe(1);
    expect(notify).toHaveBeenCalledOnce();
  });
});
