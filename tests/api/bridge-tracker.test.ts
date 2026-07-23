import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('../../src/db', () => ({
  prismaRead: {
    bridgeTransaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
  prismaWrite: {},
}));

vi.mock('../../src/bridge-tracker', () => ({
  detectBridgeTransactions: vi.fn().mockResolvedValue({ detected: false, events: [] }),
  pollAndResolvePending: vi.fn().mockResolvedValue(0),
  checkFinality: vi.fn().mockResolvedValue({ status: 'completed', confirmations: 12, requiredConfirmations: 12, reorgDetected: false, blocksUntilFinality: 0, progressPercent: 100 }),
  getVolumeByProtocol: vi.fn().mockResolvedValue([]),
  getVolumeByChain: vi.fn().mockResolvedValue([]),
  getVolumeByAsset: vi.fn().mockResolvedValue([]),
  getActivityTrends: vi.fn().mockResolvedValue([]),
  getFeeComparison: vi.fn().mockResolvedValue([]),
  getAlerts: vi.fn().mockResolvedValue({ alerts: [], total: 0 }),
  acknowledgeAlert: vi.fn().mockResolvedValue(undefined),
  addMonitoredAddress: vi.fn().mockResolvedValue({ id: 'mon-1', address: '0xabc', chain: 'ethereum', alertOnTx: true, alertOnBridging: true, active: true }),
  removeMonitoredAddress: vi.fn().mockResolvedValue(undefined),
  listMonitoredAddresses: vi.fn().mockResolvedValue([]),
  startBridgeWorker: vi.fn(),
  stopBridgeWorker: vi.fn(),
  isBridgeWorkerRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/bridge-tracker/config', () => ({
  BRIDGE_CONTRACTS: [
    { address: '0x1234', chain: 'ethereum', protocol: 'wormhole', deployedAtBlock: 0, eventSignatures: [] },
    { address: '0x5678', chain: 'bsc', protocol: 'axelar', deployedAtBlock: 0, eventSignatures: [] },
  ],
}));

const { bridgeTrackerRouter } = await import('../../src/api/bridge-tracker');

const MOCK_TX = {
  id: 'tx-1',
  transactionHash: '0xdeadbeef',
  sourceChain: 'ethereum',
  destinationChain: 'solana',
  protocol: 'wormhole',
  asset: 'USDC',
  amount: '1000000',
  sender: '0xabc',
  recipient: '0xdef',
  status: 'completed',
  fee: '1000',
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bridge-tracker', bridgeTrackerRouter);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

async function withServer(fn: (base: string) => Promise<void>) {
  const app = createTestApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}/api/v1/bridge-tracker`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /bridge-tracker/transactions', () => {
  it('returns paginated bridge transactions', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.bridgeTransaction.findMany as any).mockResolvedValue([MOCK_TX]);
    (prismaRead.bridgeTransaction.count as any).mockResolvedValue(1);

    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('transactions');
      expect(body).toHaveProperty('total', 1);
      expect(body.transactions[0].transactionHash).toBe('0xdeadbeef');
    });
  });

  it('filters by sourceChain', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.bridgeTransaction.findMany as any).mockResolvedValue([MOCK_TX]);
    (prismaRead.bridgeTransaction.count as any).mockResolvedValue(1);

    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions?sourceChain=ethereum`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.transactions).toHaveLength(1);
    });
  });

  it('returns 400 for invalid chain value', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions?sourceChain=notachain`);
      expect(res.status).toBe(400);
    });
  });

  it('returns 400 for invalid destinationChain value', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions?destinationChain=123`);
      expect(res.status).toBe(400);
    });
  });

  it('returns 400 for empty sender string', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions?sender=`);
      expect(res.status).toBe(400);
    });
  });

  it('accepts valid chain enum values for both chain params', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.bridgeTransaction.findMany as any).mockResolvedValue([]);
    (prismaRead.bridgeTransaction.count as any).mockResolvedValue(0);

    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions?sourceChain=solana&destinationChain=polygon`);
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /bridge-tracker/transactions/:hash', () => {
  it('returns transaction by hash', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.bridgeTransaction.findUnique as any).mockResolvedValue(MOCK_TX);

    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions/0xdeadbeef`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.transactionHash).toBe('0xdeadbeef');
    });
  });

  it('returns 404 when transaction not found', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.bridgeTransaction.findUnique as any).mockResolvedValue(null);

    await withServer(async (base) => {
      const res = await fetch(`${base}/transactions/0xunknown`);
      expect(res.status).toBe(404);
    });
  });
});

describe('GET /bridge-tracker/protocols', () => {
  it('returns list of supported protocols', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/protocols`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('protocols');
      expect(Array.isArray(body.protocols)).toBe(true);
      const names = body.protocols.map((p: any) => p.name);
      expect(names).toContain('wormhole');
      expect(names).toContain('axelar');
    });
  });
});

describe('GET /bridge-tracker/worker/status', () => {
  it('returns worker running state', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/worker/status`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('running', false);
    });
  });
});

describe('GET /bridge-tracker/stats/volume', () => {
  it('returns volume grouped by protocol by default', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/stats/volume`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('groupBy', 'protocol');
    });
  });

  it('returns 400 for invalid groupBy value', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/stats/volume?groupBy=invalid`);
      expect(res.status).toBe(400);
    });
  });
});

describe('GET /bridge-tracker/alerts', () => {
  it('returns alert list', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/alerts`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('alerts');
    });
  });
});
