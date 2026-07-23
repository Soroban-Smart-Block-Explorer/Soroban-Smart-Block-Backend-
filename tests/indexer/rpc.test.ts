import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sharedMockServer } = vi.hoisted(() => ({
  sharedMockServer: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
    getTransaction: vi.fn(),
    getLedger: vi.fn(),
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  function MockServer() {
    return sharedMockServer;
  }
  return { SorobanRpc: { Server: MockServer } };
});

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config', () => ({
  config: {
    stellarRpcUrl: 'http://localhost:8000',
    stellarRpcWsUrl: 'ws://localhost:8000',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
}));

import {
  fetchEvents,
  getLatestLedger,
  getTransaction,
  getRpcWebsocketUrl,
  getLedger,
} from '../../src/indexer/rpc';
import { cacheGet, cacheSet } from '../../src/cache';

describe('rpc module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('fetchEvents', () => {
    it('returns empty array when no events', async () => {
      sharedMockServer.getEvents.mockResolvedValue({ events: [] });
      const result = await fetchEvents(1000, 1010);
      expect(result).toEqual([]);
    });

    it('maps events to LedgerEvent shape', async () => {
      const fakeEvent = {
        contractId: 'CA...',
        txHash: 'abc123',
        ledger: 1005,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        topic: [],
        value: { toXDR: () => 'base64data' },
      };
      sharedMockServer.getEvents
        .mockResolvedValueOnce({ events: [fakeEvent] })
        .mockResolvedValueOnce({ events: [] });

      const result = await fetchEvents(1000, 1010);

      expect(result).toHaveLength(1);
      expect(result[0].contractId).toBe('CA...');
      expect(result[0].transactionHash).toBe('abc123');
      expect(result[0].ledgerSequence).toBe(1005);
    });

    it('filters events outside the ledger range', async () => {
      const outOfRange = {
        contractId: 'CA...',
        txHash: 'abc123',
        ledger: 1050,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        topic: [],
        value: null,
      };
      sharedMockServer.getEvents.mockResolvedValue({ events: [outOfRange] });

      const result = await fetchEvents(1000, 1010);
      expect(result).toHaveLength(0);
    });

    it('retries on rate limit error', async () => {
      const rateLimitError = { response: { status: 429 } };
      sharedMockServer.getEvents
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ events: [] });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fetchPromise = fetchEvents(1000, 1010);
      await vi.runAllTimersAsync();
      const result = await fetchPromise;

      expect(result).toEqual([]);
    });

    it('throws after max retry attempts on persistent rate limit', async () => {
      const rateLimitError = { response: { status: 429 } };
      sharedMockServer.getEvents.mockRejectedValue(rateLimitError);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const fetchPromise = fetchEvents(1000, 1010);
        await vi.runAllTimersAsync();
        await expect(fetchPromise).rejects.toMatchObject({ response: { status: 429 } });
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws on non-rate-limit errors immediately', async () => {
      sharedMockServer.getEvents.mockRejectedValue(new Error('Network error'));
      await expect(fetchEvents(1000, 1010)).rejects.toThrow('Network error');
      expect(sharedMockServer.getEvents).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLatestLedger', () => {
    it('returns ledger sequence as number', async () => {
      sharedMockServer.getLatestLedger.mockResolvedValue({ sequence: '12345' });
      const result = await getLatestLedger();
      expect(result).toBe(12345);
    });
  });

  describe('getLedger', () => {
    it('returns cached value without calling RPC', async () => {
      vi.mocked(cacheGet).mockResolvedValue({ sequence: 999 });
      const result = await getLedger(999);
      expect(result).toEqual({ sequence: 999 });
      expect(cacheSet).not.toHaveBeenCalled();
    });

    it('fetches from RPC and caches on cache miss', async () => {
      vi.mocked(cacheGet).mockResolvedValue(null);
      const fakeLedger = { sequence: 1000 };
      sharedMockServer.getLedger.mockResolvedValue(fakeLedger);

      const result = await getLedger(1000);
      expect(result).toEqual(fakeLedger);
      expect(cacheSet).toHaveBeenCalledWith('ledger:1000', fakeLedger, 86400);
    });

    it('caches ledger 0 with null TTL (indefinitely)', async () => {
      vi.mocked(cacheGet).mockResolvedValue(null);
      sharedMockServer.getLedger.mockResolvedValue({ sequence: 0 });

      await getLedger(0);
      expect(cacheSet).toHaveBeenCalledWith('ledger:0', expect.anything(), null);
    });
  });

  describe('getTransaction', () => {
    it('returns transaction result', async () => {
      const fakeTx = { status: 'SUCCESS', envelopeXdr: {} };
      sharedMockServer.getTransaction.mockResolvedValue(fakeTx);
      const result = await getTransaction('abc123');
      expect(result).toEqual(fakeTx);
    });
  });

  describe('getRpcWebsocketUrl', () => {
    it('returns the configured WebSocket URL', () => {
      const url = getRpcWebsocketUrl();
      expect(url).toBe('ws://localhost:8000');
    });
  });
});
