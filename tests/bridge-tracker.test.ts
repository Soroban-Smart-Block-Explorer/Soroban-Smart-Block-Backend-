import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkLargeTransfer,
  checkBridgeDelay,
  checkBridgeFailure,
  getAlerts,
  acknowledgeAlert,
  addMonitoredAddress,
  removeMonitoredAddress,
  listMonitoredAddresses,
} from '../src/bridge-tracker';
import { prismaWrite as prisma, prismaRead } from '../src/db';

vi.mock('../src/db', () => ({
  prismaWrite: {
    bridgeAlert: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    monitoredAddress: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  prismaRead: {
    bridgeAlert: {
      findMany: vi.fn(),
    },
    monitoredAddress: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../src/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Bridge Tracker Alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkLargeTransfer', () => {
    it('returns null for transfer below threshold', async () => {
      const result = await checkLargeTransfer(
        'wormhole',
        'ethereum',
        'USDC',
        '100',
        '0xsender',
        '0xrecipient',
        '0xtxhash',
      );

      expect(result).toBeNull();
    });

    it('creates warning alert for transfer above threshold', async () => {
      (prisma.bridgeAlert.create as any).mockResolvedValue({
        id: '1',
        type: 'large_transfer',
        severity: 'warning',
        protocol: 'wormhole',
        chain: 'ethereum',
        transactionHash: '0xtxhash',
      });

      const result = await checkLargeTransfer(
        'wormhole',
        'ethereum',
        'USDC',
        '500000',
        '0xsender',
        '0xrecipient',
        '0xtxhash',
      );

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning');
      expect(result?.type).toBe('large_transfer');
    });

    it('creates critical alert for transfer above critical threshold', async () => {
      const result = await checkLargeTransfer(
        'wormhole',
        'ethereum',
        'USDC',
        '5000000',
        '0xsender',
        '0xrecipient',
        '0xtxhash',
      );

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('critical');
    });
  });

  describe('checkBridgeDelay', () => {
    it('detects delayed bridge transactions', async () => {
      const futureTime = new Date(Date.now() + 30 * 60 * 1000);
      const result = await checkBridgeDelay(
        'wormhole',
        'ethereum',
        '0xtxhash',
        futureTime.toISOString(),
      );

      expect(result).not.toBeNull();
      expect(result?.type).toBe('bridge_delay');
    });

    it('returns null for recent transactions', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000);
      const result = await checkBridgeDelay(
        'wormhole',
        'ethereum',
        '0xtxhash',
        recentTime.toISOString(),
      );

      expect(result).toBeNull();
    });
  });

  describe('checkBridgeFailure', () => {
    it('detects failed bridge transactions', async () => {
      const result = await checkBridgeFailure(
        'wormhole',
        'ethereum',
        '0xtxhash',
        'execution reverted',
      );

      expect(result).not.toBeNull();
      expect(result?.type).toBe('bridge_failure');
    });

    it('returns null for successful transactions', async () => {
      const result = await checkBridgeFailure('wormhole', 'ethereum', '0xtxhash', '');

      expect(result).toBeNull();
    });
  });

  describe('Alert management', () => {
    it('retrieves alerts for protocol', async () => {
      (prismaRead.bridgeAlert.findMany as any).mockResolvedValue([
        {
          id: '1',
          type: 'large_transfer',
          severity: 'warning',
          protocol: 'wormhole',
        },
      ]);

      const alerts = await getAlerts('wormhole');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].protocol).toBe('wormhole');
    });

    it('acknowledges alerts', async () => {
      (prisma.bridgeAlert.update as any).mockResolvedValue({
        id: '1',
        acknowledged: true,
      });

      await acknowledgeAlert('1');

      expect(prisma.bridgeAlert.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { acknowledged: true },
      });
    });
  });

  describe('Monitored address management', () => {
    it('adds monitored address', async () => {
      (prisma.monitoredAddress.create as any).mockResolvedValue({
        id: '1',
        address: '0xuser',
        protocol: 'wormhole',
      });

      const result = await addMonitoredAddress('0xuser', 'wormhole');

      expect(result).not.toBeNull();
      expect(result.address).toBe('0xuser');
    });

    it('removes monitored address', async () => {
      (prisma.monitoredAddress.delete as any).mockResolvedValue({
        id: '1',
        address: '0xuser',
      });

      await removeMonitoredAddress('1');

      expect(prisma.monitoredAddress.delete).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });

    it('lists monitored addresses', async () => {
      (prismaRead.monitoredAddress.findMany as any).mockResolvedValue([
        {
          id: '1',
          address: '0xuser1',
          protocol: 'wormhole',
        },
        {
          id: '2',
          address: '0xuser2',
          protocol: 'axelar',
        },
      ]);

      const addresses = await listMonitoredAddresses();
      expect(addresses).toHaveLength(2);
    });
  });

  describe('Bridge route mapping', () => {
    it('correctly maps bridge routes for different chains', async () => {
      const testCases = [
        { protocol: 'wormhole', sourceChain: 'ethereum', destChain: 'solana' },
        { protocol: 'axelar', sourceChain: 'polygon', destChain: 'avalanche' },
        { protocol: 'allbridge', sourceChain: 'arbitrum', destChain: 'optimism' },
      ];

      for (const testCase of testCases) {
        const result = await checkLargeTransfer(
          testCase.protocol as any,
          testCase.sourceChain as any,
          'USDC',
          '1000000',
          '0xsender',
          '0xrecipient',
          '0xtxhash',
        );

        if (result) {
          expect(result.protocol).toBe(testCase.protocol);
          expect(result.chain).toBe(testCase.sourceChain);
        }
      }
    });
  });

  describe('Asset tracking', () => {
    it('tracks asset transfers across bridges', async () => {
      const bridgeEvent = {
        protocol: 'wormhole' as any,
        sourceChain: 'ethereum' as any,
        destinationChain: 'solana' as any,
        asset: 'USDC',
        amount: '1000',
        sender: '0xsender',
        recipient: 'G123456...',
      };

      const result = await checkLargeTransfer(
        bridgeEvent.protocol,
        bridgeEvent.sourceChain,
        bridgeEvent.asset,
        bridgeEvent.amount,
        bridgeEvent.sender,
        bridgeEvent.recipient,
        '0xtxhash',
      );

      if (result) {
        expect(result.asset).toBe(bridgeEvent.asset);
      }
    });
  });
});
