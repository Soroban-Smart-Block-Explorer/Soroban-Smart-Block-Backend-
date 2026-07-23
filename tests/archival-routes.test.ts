import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaWrite: {
    backfillRequest: {
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
  prismaRead: {
    backfillRequest: {
      // backfill.ts aliases prismaRead as `prisma` and uses it for all ops including create/update
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    devApiKey: { findFirst: vi.fn() },
  },
  // archive/archiver.ts uses the bare `prisma` import
  prisma: {
    contractStateChange: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../src/archive/query-engine', () => ({
  getStateAtLedger: vi.fn(),
  getKeyHistory: vi.fn(),
  getLedgerDiff: vi.fn(),
  getFullSnapshot: vi.fn(),
}));

vi.mock('../src/archive/archiver', () => ({
  captureStateChangesForTransaction: vi.fn(),
}));

vi.mock('../src/archive/scval-decoder', () => ({
  decodeScValXdr: vi.fn((xdr: string) => `decoded:${xdr}`),
}));

vi.mock('../src/middleware/sanitize', () => ({
  validateAddressParam: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  isValidStellarAddress: vi.fn(() => true),
  assertValidStellarAddress: vi.fn(),
  sanitizeString: vi.fn((s: unknown) => s),
  sanitizeObject: vi.fn((o: unknown) => o),
  sanitizeInputs: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveAddress: vi.fn((s: unknown) => s),
}));

vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

vi.mock('../src/feed/channelManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/feed/channelManager')>();
  const validNames = ['transactions', 'trades', 'events', 'ledgers'];
  for (const name of validNames) {
    (original.ChannelManager as any)['channels'].set(name, {
      name,
      category: 'transaction',
      schema: {},
    });
  }
  return original;
});

import {
  getStateAtLedger,
  getKeyHistory,
  getLedgerDiff,
  getFullSnapshot,
} from '../src/archive/query-engine';
import { captureStateChangesForTransaction } from '../src/archive/archiver';
import { prismaRead } from '../src/db';
import { archiveRouter } from '../src/api/archive';
import { storageRouter } from '../src/api/storage';
import backfillRouter from '../src/api/backfill';

// ── Test server ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mirror production mount layout
  // archiveRouter uses mergeParams, so mount it nested under a :address param
  const contractsRouter = express.Router();
  contractsRouter.use('/:address/state', archiveRouter);
  app.use('/contracts', contractsRouter);

  app.use('/storage', storageRouter);

  // backfill-specific sub-paths before the broad /feed/backfill mount
  app.use('/feed/backfill', backfillRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => vi.clearAllMocks());

const CONTRACT = 'CTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE';

// ── archiveRouter export ──────────────────────────────────────────────────────

describe('archiveRouter export', () => {
  it('exports a named router', () => {
    expect(typeof archiveRouter).toBe('function');
    expect(archiveRouter).toHaveProperty('stack');
  });
});

// ── GET /contracts/:address/state — state at ledger ───────────────────────────

describe('GET /contracts/:address/state', () => {
  it('returns state data for a valid ledger', async () => {
    const fixture = { entries: [{ key: 'abc', value: '123' }], total: 1, page: 1, pageSize: 100 };
    (getStateAtLedger as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state?ledger=1000`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(getStateAtLedger).toHaveBeenCalledWith(CONTRACT, 1000, expect.any(Object));
  });

  it('returns 400 when ledger param is missing', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-numeric ledger', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state?ledger=abc`);
    expect(res.status).toBe(400);
  });
});

// ── GET /contracts/:address/state/history ─────────────────────────────────────

describe('GET /contracts/:address/state/history', () => {
  it('returns key history for a valid key', async () => {
    const fixture = { key: 'abc', history: [{ ledger: 100, value: 'old' }] };
    (getKeyHistory as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/history?key=abc`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe('abc');
    expect(getKeyHistory).toHaveBeenCalledWith(CONTRACT, 'abc');
  });

  it('returns 400 when key is missing', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/history`);
    expect(res.status).toBe(400);
  });
});

// ── GET /contracts/:address/state/diff ───────────────────────────────────────

describe('GET /contracts/:address/state/diff', () => {
  it('returns a ledger diff for a valid range', async () => {
    const fixture = { added: [], modified: [{ key: 'k', before: 'a', after: 'b' }], removed: [] };
    (getLedgerDiff as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/diff?from=100&to=200`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.modified).toHaveLength(1);
    expect(getLedgerDiff).toHaveBeenCalledWith(CONTRACT, 100, 200);
  });

  it('returns 400 when from >= to', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/diff?from=200&to=100`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be less than/);
  });

  it('returns 400 when params are missing', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/diff?from=100`);
    expect(res.status).toBe(400);
  });
});

// ── GET /contracts/:address/state/snapshot ────────────────────────────────────

describe('GET /contracts/:address/state/snapshot', () => {
  it('returns a full snapshot at a given ledger', async () => {
    const fixture = { ledger: 500, entries: { balance: '1000' } };
    (getFullSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/snapshot?ledger=500`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledger).toBe(500);
    expect(getFullSnapshot).toHaveBeenCalledWith(CONTRACT, 500);
  });

  it('returns 400 when ledger is missing', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/snapshot`);
    expect(res.status).toBe(400);
  });
});

// ── POST /contracts/:address/state/ingest ─────────────────────────────────────

describe('POST /contracts/:address/state/ingest', () => {
  const VALID_INGEST = {
    transactionHash: 'abc123',
    ledger: 1000,
    ledgerCloseTime: '2024-01-01T00:00:00.000Z',
    changes: [{ key: 'k1', before: 'v0', after: 'v1' }],
  };

  it('ingests state changes and returns 201', async () => {
    (captureStateChangesForTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_INGEST),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.saved).toBe(1);
    expect(captureStateChangesForTransaction).toHaveBeenCalledOnce();
  });

  it('returns 400 when changes array is empty', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INGEST, changes: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when transactionHash is missing', async () => {
    const { transactionHash: _omitted, ...rest } = VALID_INGEST;
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /contracts/:address/state/decode ─────────────────────────────────────

describe('GET /contracts/:address/state/decode', () => {
  it('decodes an XDR value', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/decode?xdr=AAAA`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.human).toBe('decoded:AAAA');
  });

  it('returns 400 when xdr param is missing', async () => {
    const res = await fetch(`${baseUrl}/contracts/${CONTRACT}/state/decode`);
    expect(res.status).toBe(400);
  });
});

// ── storageRouter ─────────────────────────────────────────────────────────────

describe('storageRouter export', () => {
  it('exports a named router', () => {
    expect(typeof storageRouter).toBe('function');
    expect(storageRouter).toHaveProperty('stack');
  });
});

describe('GET /storage', () => {
  it('returns service overview with endpoint list', async () => {
    const res = await fetch(`${baseUrl}/storage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('Storage API');
    expect(Array.isArray(body.endpoints)).toBe(true);
  });
});

describe('GET /storage/contracts/:contractId', () => {
  it('returns storage overview for a contract', async () => {
    const res = await fetch(`${baseUrl}/storage/contracts/${CONTRACT}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contractId).toBe(CONTRACT);
    expect(body.storageEntries).toHaveProperty('persistent');
  });
});

describe('GET /storage/contracts/:contractId/entries', () => {
  it('returns entry list with filter metadata', async () => {
    const res = await fetch(`${baseUrl}/storage/contracts/${CONTRACT}/entries?type=persistent`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contractId).toBe(CONTRACT);
    expect(body.filter.type).toBe('persistent');
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe('GET /storage/network/stats', () => {
  it('returns network-wide storage statistics', async () => {
    const res = await fetch(`${baseUrl}/storage/network/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalContracts');
    expect(body).toHaveProperty('computedAt');
  });
});

describe('GET /storage/network/top-users', () => {
  it('returns top storage users with pagination info', async () => {
    const res = await fetch(`${baseUrl}/storage/network/top-users?limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(5);
    expect(Array.isArray(body.topUsers)).toBe(true);
  });
});

// ── backfillRouter — operator auth guard ──────────────────────────────────────

describe('backfillRouter export', () => {
  it('exports a default router', () => {
    expect(typeof backfillRouter).toBe('function');
    expect(backfillRouter).toHaveProperty('stack');
  });
});

const VALID_BACKFILL = {
  channelName: 'transactions',
  startTime: '2024-01-01T00:00:00.000Z',
  endTime: '2024-01-15T00:00:00.000Z',
  format: 'jsonl',
};

describe('POST /feed/backfill — operator auth', () => {
  it('returns 401 when no operator token is provided', async () => {
    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BACKFILL),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/operator token required/i);
  });

  it('accepts x-operator-token and creates a backfill request', async () => {
    const fixture = {
      id: 'bf-001',
      status: 'pending',
      channelName: 'transactions',
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-01-15'),
      format: 'jsonl',
    };
    (prismaRead.backfillRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);
    (prismaRead.backfillRequest.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-operator-token': 'secret-operator-token',
      },
      body: JSON.stringify(VALID_BACKFILL),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.requestId).toBe('bf-001');
    expect(body.status).toBe('pending');
  });

  it('accepts x-admin-token as an alternative operator credential', async () => {
    const fixture = { id: 'bf-002', status: 'pending' };
    (prismaRead.backfillRequest.create as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);
    (prismaRead.backfillRequest.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin-fallback-token',
      },
      body: JSON.stringify(VALID_BACKFILL),
    });

    expect(res.status).toBe(202);
  });

  it('returns 400 for an invalid channel name even with a valid token', async () => {
    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-operator-token': 'secret-operator-token',
      },
      body: JSON.stringify({ ...VALID_BACKFILL, channelName: 'nonexistent' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid channel/i);
  });

  it('returns 400 when date range exceeds 90 days', async () => {
    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-operator-token': 'secret-operator-token',
      },
      body: JSON.stringify({
        ...VALID_BACKFILL,
        startTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-04-30T00:00:00.000Z', // > 90 days
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/90 days/);
  });

  it('returns 400 when startTime is after endTime', async () => {
    const res = await fetch(`${baseUrl}/feed/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-operator-token': 'secret-operator-token',
      },
      body: JSON.stringify({
        ...VALID_BACKFILL,
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/before end time/i);
  });
});

describe('GET /feed/backfill/:requestId', () => {
  it('returns the backfill request when found', async () => {
    const fixture = {
      id: 'bf-001',
      channelName: 'transactions',
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-01-15'),
      format: 'jsonl',
      status: 'processing',
      progress: 42,
      createdAt: new Date(),
    };
    (prismaRead.backfillRequest.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/feed/backfill/bf-001`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBe('bf-001');
    expect(body.status).toBe('processing');
    expect(body.progress).toBe(42);
  });

  it('returns 404 when the request does not exist', async () => {
    (prismaRead.backfillRequest.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/feed/backfill/unknown`);
    expect(res.status).toBe(404);
  });

  it('includes downloadUrl for a completed request', async () => {
    const fixture = {
      id: 'bf-complete',
      channelName: 'trades',
      startTime: new Date('2024-01-01'),
      endTime: new Date('2024-01-07'),
      format: 'csv',
      status: 'completed',
      progress: 100,
      fileUrl: 'https://example.com/file.csv',
      fileSizeBytes: 1024,
      recordCount: 500,
      completedAt: new Date(),
      createdAt: new Date(),
    };
    (prismaRead.backfillRequest.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);

    const res = await fetch(`${baseUrl}/feed/backfill/bf-complete`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadUrl).toBe('https://example.com/file.csv');
    expect(body.recordCount).toBe(500);
  });
});

describe('GET /feed/backfill/limits', () => {
  it('returns the backfill limits configuration', async () => {
    const res = await fetch(`${baseUrl}/feed/backfill/limits`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxRangeDays).toBe(90);
    expect(Array.isArray(body.supportedFormats)).toBe(true);
  });
});
