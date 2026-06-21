import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freezeRouter } from '../../src/api/freeze';
import express from 'express';
import request from 'supertest';
import { prismaWrite as prisma } from '../../src/db';
import { scanForFrozenKeys, recordFreezeViolation } from '../../src/indexer/freeze-scanner';

// Mock DB
vi.mock('../../src/db', () => ({
  prismaWrite: {
    frozenLedgerKey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    freezeViolation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    indexerState: {
      findUnique: vi.fn().mockResolvedValue({ lastLedger: 100 }),
    },
    transaction: {
      updateMany: vi.fn(),
    }
  }
}));

const app = express();
app.use(express.json());
app.use('/api/v1/freeze', freezeRouter);

describe('Freeze Management API & Scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scanner logic', () => {
    it('recordFreezeViolation calculates severity correctly', async () => {
      await recordFreezeViolation('hash1', 'contract', 100, new Date(), ['key1', 'key2', 'key3']);
      expect(prisma.freezeViolation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ severity: 'medium' })
        })
      );
    });

    it('recordFreezeViolation triggers critical alert if > 10 keys', async () => {
      const keys = Array.from({ length: 11 }, (_, i) => `key${i}`);
      const mockFetch = vi.fn().mockResolvedValue({});
      global.fetch = mockFetch as any;
      process.env.FREEZE_ALERT_WEBHOOK_URL = 'http://alert.url';
      
      await recordFreezeViolation('hash_critical', 'contract', 100, new Date(), keys);
      
      expect(prisma.freezeViolation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ severity: 'critical' })
        })
      );
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('API Endpoints', () => {
    it('GET /api/v1/freeze/keys returns data', async () => {
      (prisma.frozenLedgerKey.findMany as any).mockResolvedValue([{ id: '1', ledgerKey: 'keyA' }]);
      (prisma.frozenLedgerKey.count as any).mockResolvedValue(1);

      const res = await request(app).get('/api/v1/freeze/keys');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('POST /api/v1/freeze/keys creates a key and logs audit', async () => {
      const newKey = { id: 'k1', ledgerKey: 'keyX' };
      (prisma.frozenLedgerKey.create as any).mockResolvedValue(newKey);
      
      const res = await request(app)
        .post('/api/v1/freeze/keys')
        .set('x-admin-token', 'admin1')
        .send({ ledgerKey: 'keyX', reason: 'sus' });
        
      expect(res.status).toBe(201);
      expect(prisma.frozenLedgerKey.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'CREATE_FREEZE' })
        })
      );
    });

    it('PATCH /api/v1/freeze/violations/:id resolves violation', async () => {
      (prisma.freezeViolation.findUnique as any).mockResolvedValue({ id: 'v1' });
      (prisma.freezeViolation.update as any).mockResolvedValue({ id: 'v1', resolution: 'resolved' });

      const res = await request(app)
        .patch('/api/v1/freeze/violations/v1')
        .set('x-admin-token', 'admin1')
        .send({ resolution: 'resolved' });
        
      expect(res.status).toBe(200);
      expect(res.body.resolution).toBe('resolved');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'RESOLVE_VIOLATION' })
        })
      );
    });
  });
});
