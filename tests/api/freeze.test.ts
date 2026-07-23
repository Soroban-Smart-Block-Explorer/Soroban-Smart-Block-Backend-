import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  prismaWrite: {
    frozenLedgerKey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    freezeViolation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
    indexerState: {
      findUnique: vi.fn().mockResolvedValue({ lastLedger: 1000 }),
    },
  },
}));

vi.mock('../../src/indexer/freeze-scanner', () => ({
  invalidateFreezeCache: vi.fn(),
}));

import * as db from '../../src/db';
import { freezeRouter } from '../../src/api/freeze';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/freeze', freezeRouter);
  return app;
}

describe('GET /freeze/keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns frozen keys list', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findMany).mockResolvedValue([
      { id: 'key-1', ledgerKey: 'key_data', active: true },
    ] as any);
    vi.mocked(db.prismaWrite.frozenLedgerKey.count).mockResolvedValue(1);

    const res = await request(makeApp()).get('/freeze/keys');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('filters by active status', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaWrite.frozenLedgerKey.count).mockResolvedValue(0);

    const res = await request(makeApp()).get('/freeze/keys?active=true');
    expect(res.status).toBe(200);
  });
});

describe('GET /freeze/keys/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when key not found', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findUnique).mockResolvedValue(null);

    const res = await request(makeApp()).get('/freeze/keys/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns key when found', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findUnique).mockResolvedValue({
      id: 'key-1',
      ledgerKey: 'key_data',
    } as any);

    const res = await request(makeApp()).get('/freeze/keys/key-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('key-1');
  });
});

describe('POST /freeze/keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without admin token', async () => {
    const res = await request(makeApp()).post('/freeze/keys').send({ ledgerKey: 'key_data' });
    expect(res.status).toBe(401);
  });

  it('creates freeze key with admin token', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.create).mockResolvedValue({
      id: 'key-1',
      ledgerKey: 'key_data',
    } as any);
    vi.mocked(db.prismaWrite.indexerState.findUnique).mockResolvedValue({
      lastLedger: 1000,
    } as any);

    const res = await request(makeApp())
      .post('/freeze/keys')
      .set('x-admin-token', 'admin-secret')
      .send({ ledgerKey: 'key_data', reason: 'regulatory' });

    expect(res.status).toBe(201);
  });

  it('returns 400 for missing ledgerKey', async () => {
    const res = await request(makeApp())
      .post('/freeze/keys')
      .set('x-admin-token', 'admin-secret')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('DELETE /freeze/keys/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without admin token', async () => {
    const res = await request(makeApp()).delete('/freeze/keys/key-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when key not found', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findUnique).mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/freeze/keys/nonexistent')
      .set('x-admin-token', 'admin-secret');
    expect(res.status).toBe(404);
  });

  it('deletes key and returns success message', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.findUnique).mockResolvedValue({
      id: 'key-1',
    } as any);
    vi.mocked(db.prismaWrite.frozenLedgerKey.delete).mockResolvedValue({} as any);

    const res = await request(makeApp())
      .delete('/freeze/keys/key-1')
      .set('x-admin-token', 'admin-secret');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Deleted');
  });
});

describe('GET /freeze/stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns freeze statistics', async () => {
    vi.mocked(db.prismaWrite.frozenLedgerKey.count)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8);
    vi.mocked(db.prismaWrite.freezeViolation.count)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);

    const res = await request(makeApp()).get('/freeze/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalKeys');
    expect(res.body).toHaveProperty('activeKeys');
    expect(res.body).toHaveProperty('totalViolations');
    expect(res.body).toHaveProperty('criticalViolations');
  });
});

describe('GET /freeze/violations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns violations list', async () => {
    vi.mocked(db.prismaWrite.freezeViolation.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaWrite.freezeViolation.count).mockResolvedValue(0);

    const res = await request(makeApp()).get('/freeze/violations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /freeze/audit-log', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns audit log entries', async () => {
    vi.mocked(db.prismaWrite.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(db.prismaWrite.auditLog.count).mockResolvedValue(0);

    const res = await request(makeApp()).get('/freeze/audit-log');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
