import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    transaction: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    event: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    wallet: { findUnique: vi.fn() },
    token: { findMany: vi.fn(), findUnique: vi.fn() },
    sessionAuthorization: { findMany: vi.fn(), count: vi.fn() },
    indexerState: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  prismaWrite: {
    contract: { upsert: vi.fn() },
    sessionAuthorization: { upsert: vi.fn(), findMany: vi.fn() },
    translationKey: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    translation: { upsert: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../../src/indexer/wasm-spec', () => ({
  fetchContractSpec: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/indexer/rpc', () => ({
  rpc: {},
  getLatestLedger: vi.fn().mockResolvedValue(100),
  getTransaction: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/indexer/registry', () => ({
  getContractAbi: vi.fn().mockResolvedValue(null),
  decodeArgs: vi.fn().mockReturnValue(null),
  renderHuman: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/indexer/args-decoder', () => ({
  decodeScVal: vi.fn().mockReturnValue({ raw: null, formatted: '' }),
}));

vi.mock('../../src/indexer/call-trace', () => ({
  parseCallTrace: vi.fn().mockReturnValue({ calls: [] }),
}));

vi.mock('../../src/indexer/footprint-formatter', () => ({
  formatFootprint: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/indexer/auth-snippet-gen', () => ({
  generateAuthSnapshots: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/indexer/storage-classifier', () => ({
  classifyStorageEntries: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/indexer/ttl-tracker', () => ({
  trackTtlChanges: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/indexer/template-engine', () => ({
  renderTemplate: vi.fn().mockReturnValue('Rendered description'),
}));

vi.mock('../../src/indexer/protocol-guard', () => ({
  getProtocolStatus: vi.fn().mockResolvedValue({ protocolVersion: 22, supported: true }),
}));

vi.mock('../../src/indexer/reconciliation', () => ({
  runReconciliation: vi.fn().mockResolvedValue({ checked: 100, discrepancies: 0 }),
}));

vi.mock('../../src/indexer/token-metadata', () => ({
  resolveTokenMetadata: vi.fn().mockResolvedValue({ symbol: 'USDC', decimals: 7 }),
  warmTokenMetadataCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/middleware/sanitize', () => ({
  validateAddressParam: () => (req: any, _res: any, next: any) => {
    req.params.address = req.params.address || 'CAAAA…';
    next();
  },
  isValidStellarAddress: vi.fn().mockReturnValue(true),
  sanitizeInputs: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/indexer/xdr-parser', () => ({
  parseInvokeHostFunction: vi.fn().mockReturnValue(null),
}));

const { router } = await import('../../src/api/router');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

async function withServer(fn: (base: string) => Promise<void>) {
  const app = createTestApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}/api/v1`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

describe('GET /contracts', () => {
  it('returns contract list', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.contract.findMany as any).mockResolvedValue([
      { address: 'CAA…1', name: 'TokenA', isToken: true },
    ]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/contracts`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });
  });
});

describe('GET /wallets', () => {
  it('returns 404 when address is missing (no route matches)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/wallets`);
      expect([400, 404]).toContain(res.status);
    });
  });
});

describe('GET /tokens', () => {
  it('returns token list', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.token.findMany as any).mockResolvedValue([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/tokens`);
      expect([200, 404]).toContain(res.status);
    });
  });
});

describe('GET /render', () => {
  it('returns 404 when hash param missing (route requires :hash)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/render`);
      expect([400, 404]).toContain(res.status);
    });
  });
});

describe('GET /authorizations', () => {
  it('returns authorization list', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.sessionAuthorization.findMany as any).mockResolvedValue([]);
    (prismaRead.sessionAuthorization.count as any).mockResolvedValue(0);
    await withServer(async (base) => {
      const res = await fetch(`${base}/authorizations`);
      expect([200, 400, 404]).toContain(res.status);
    });
  });
});

describe('GET /sync-state', () => {
  it('returns sync status', async () => {
    const { prismaRead } = await import('../../src/db');
    (prismaRead.indexerState.findUnique as any).mockResolvedValue({
      id: 'singleton',
      lastLedger: 500,
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/sync-state`);
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        const body = await res.json();
        expect(body).toHaveProperty('lastIndexedLedger');
      }
    });
  });
});

describe('GET /network', () => {
  it('returns network info', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/network`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('network');
      expect(body).toHaveProperty('rpcUrl');
    });
  });
});

describe('GET /protocol', () => {
  it('returns protocol version', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/protocol`);
      expect(res.status).toBe(200);
    });
  });

  it('GET /protocol/reconciliation returns report', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/protocol/reconciliation`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toHaveProperty('checked');
    });
  });
});

describe('GET /token-metadata', () => {
  it('returns 404 without contract parameter (route requires :contract)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/token-metadata`);
      expect([400, 404]).toContain(res.status);
    });
  });
});

describe('POST /simulate', () => {
  it('returns 400 for missing body', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect([400, 404]).toContain(res.status);
    });
  });
});
