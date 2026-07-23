import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    transaction: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { WhaleWatcher, initWhaleWatcher, getWhaleWatcher } from '../../src/indexer/whaleWatcher';
import * as db from '../../src/db';

const { transaction } = db.prismaWrite;

describe('WhaleWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('monitorEvent', () => {
    it('does nothing when asset is missing', async () => {
      const watcher = new WhaleWatcher();
      const alertSpy = vi.fn();
      watcher.on('whale-alert', alertSpy);

      await watcher.monitorEvent({ decoded: { amount: 999999999 } });
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does nothing when amount is missing', async () => {
      const watcher = new WhaleWatcher();
      const alertSpy = vi.fn();
      watcher.on('whale-alert', alertSpy);

      await watcher.monitorEvent({ decoded: { asset: 'USDC' } });
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does nothing when asset has no threshold configured', async () => {
      const watcher = new WhaleWatcher();
      const alertSpy = vi.fn();
      watcher.on('whale-alert', alertSpy);

      await watcher.monitorEvent({ decoded: { asset: 'UNKNOWN_TOKEN', amount: 999999999 } });
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does nothing when amount is below threshold', async () => {
      const watcher = new WhaleWatcher();
      const alertSpy = vi.fn();
      watcher.on('whale-alert', alertSpy);

      await watcher.monitorEvent({
        decoded: { asset: 'USDC', amount: 1000 }, // well below 50k USDC threshold
        transactionHash: 'abc',
        contractAddress: 'CA...',
        eventType: 'transfer',
        sourceAccount: 'GA...',
        ledgerSequence: 1000,
        ledgerCloseTime: new Date(),
      });
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('emits whale-alert and updates DB when amount exceeds threshold', async () => {
      const watcher = new WhaleWatcher();
      const alertSpy = vi.fn();
      watcher.on('whale-alert', alertSpy);

      await watcher.monitorEvent({
        decoded: { asset: 'USDC', amount: 100_000e6 }, // 100k USDC
        transactionHash: 'tx-whale-1',
        contractAddress: 'CA...',
        eventType: 'transfer',
        sourceAccount: 'GA...',
        ledgerSequence: 1000,
        ledgerCloseTime: new Date(),
      });

      expect(alertSpy).toHaveBeenCalledOnce();
      expect(alertSpy.mock.calls[0][0]).toMatchObject({
        asset: 'USDC',
        amount: 100_000e6,
        transactionHash: 'tx-whale-1',
      });
      expect(db.prismaWrite.transaction.update).toHaveBeenCalledOnce();
    });

    it('does not throw when DB update fails', async () => {
      vi.mocked(db.prismaWrite.transaction.update).mockRejectedValueOnce(new Error('DB down'));
      const watcher = new WhaleWatcher();

      await expect(
        watcher.monitorEvent({
          decoded: { asset: 'USDC', amount: 100_000e6 },
          transactionHash: 'tx-1',
          contractAddress: 'CA...',
          eventType: 'transfer',
          sourceAccount: 'GA...',
          ledgerSequence: 1000,
          ledgerCloseTime: new Date(),
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('setThreshold', () => {
    it('updates threshold for existing asset', () => {
      const watcher = new WhaleWatcher();
      watcher.setThreshold('USDC', 1_000_000, 1_000_000);
      const thresholds = watcher.getThresholds();
      const usdc = thresholds.find((t) => t.asset === 'USDC');
      expect(usdc?.threshold).toBe(1_000_000);
    });

    it('adds threshold for new asset', () => {
      const watcher = new WhaleWatcher();
      watcher.setThreshold('NEWTOKEN', 500, 500);
      const thresholds = watcher.getThresholds();
      expect(thresholds.some((t) => t.asset === 'NEWTOKEN')).toBe(true);
    });
  });

  describe('getThresholds', () => {
    it('returns default thresholds', () => {
      const watcher = new WhaleWatcher();
      const thresholds = watcher.getThresholds();
      expect(thresholds.length).toBeGreaterThan(0);
      expect(thresholds.some((t) => t.asset === 'USDC')).toBe(true);
      expect(thresholds.some((t) => t.asset === 'XLM')).toBe(true);
    });

    it('returns custom thresholds when provided', () => {
      const watcher = new WhaleWatcher([{ asset: 'BTC', threshold: 1, usdEquivalent: 60000 }]);
      const thresholds = watcher.getThresholds();
      expect(thresholds).toHaveLength(1);
      expect(thresholds[0].asset).toBe('BTC');
    });
  });

  describe('initWhaleWatcher / getWhaleWatcher', () => {
    it('initWhaleWatcher returns a WhaleWatcher instance', () => {
      const watcher = initWhaleWatcher();
      expect(watcher).toBeInstanceOf(WhaleWatcher);
    });

    it('getWhaleWatcher returns an instance', () => {
      const watcher = getWhaleWatcher();
      expect(watcher).toBeInstanceOf(WhaleWatcher);
    });
  });
});
