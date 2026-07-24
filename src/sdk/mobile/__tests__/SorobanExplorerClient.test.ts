import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanExplorerClient } from '../SorobanExplorerClient';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SorobanExplorerClient', () => {
  let client: SorobanExplorerClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new SorobanExplorerClient({
      baseUrl: 'https://api.soroban.network',
      apiKey: 'test-key',
      timeout: 5000,
    });
  });

  it('should initialize with default config', () => {
    const c = new SorobanExplorerClient({ baseUrl: 'https://api.test.com' });
    expect(c).toBeDefined();
  });

  it('should fetch transactions with pagination', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], page: 1, limit: 20, total: 0, hasMore: false }),
    });
    const result = await client.getTransactions({ page: 1, limit: 20 });
    expect(result.data).toEqual([]);
    expect(result.page).toBe(1);
  });

  it('should retry on 429 status', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ message: 'rate limited' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [], page: 1, limit: 20, total: 0, hasMore: false }),
      });
    const result = await client.getTransactions();
    expect(result.data).toEqual([]);
  });

  it('should cache GET responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], page: 1, limit: 20, total: 0, hasMore: false }),
    });
    await client.getTransactions();
    await client.getTransactions();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should queue mutations when offline', async () => {
    client.setOnlineStatus(false);
    const sub = { type: 'price_alert' as const, config: {}, enabled: true };
    await expect(client.createSubscription(sub)).rejects.toThrow('Offline');
    expect(client.getQueuedOperations().length).toBe(1);
  });

  it('should invalidate cache by pattern', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], page: 1, limit: 20, total: 0, hasMore: false }),
    });
    await client.getTransactions();
    client.invalidateCache(/\/transactions/);
    await client.getTransactions();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
