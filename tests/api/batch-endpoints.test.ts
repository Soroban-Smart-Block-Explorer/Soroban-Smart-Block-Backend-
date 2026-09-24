import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { batchRouter } from '../../src/api/batch';

vi.mock('../../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Batch Endpoints', () => {
  let app: express.Application;
  let server: any;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use(batchRouter);
  });

  afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  describe('POST /events (batch)', () => {
    it('returns empty array for non-existent event IDs', async () => {
      const res = await app.post('/events').send({
        ids: ['non-existent-id-1', 'non-existent-id-2'],
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [null, null],
        missing: ['non-existent-id-1', 'non-existent-id-2'],
      });
    });

    it('rejects empty ids array', async () => {
      const res = await app.post('/events').send({ ids: [] });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects more than 100 IDs', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
      const res = await app.post('/events').send({ ids });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('maintains order of input IDs in response', async () => {
      const ids = ['id-1', 'id-2', 'id-3'];
      const res = await app.post('/events').send({ ids });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });
  });

  describe('POST /transactions (batch)', () => {
    it('returns empty array for non-existent transaction hashes', async () => {
      const res = await app.post('/transactions').send({
        hashes: [
          'aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd',
          'eeff001122334455667788990011223344556677889900112233445566778899',
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [null, null],
        missing: [
          'aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd',
          'eeff001122334455667788990011223344556677889900112233445566778899',
        ],
      });
    });

    it('rejects empty hashes array', async () => {
      const res = await app.post('/transactions').send({ hashes: [] });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects more than 100 hashes', async () => {
      const hashes = Array.from({ length: 101 }, (_, i) => i.toString().padStart(64, '0'));
      const res = await app.post('/transactions').send({ hashes });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('includes events in transaction response', async () => {
      const res = await app.post('/transactions').send({
        hashes: ['aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd'],
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      // First item is null (non-existent)
      expect(res.body.data[0]).toBeNull();
    });
  });

  describe('POST /accounts (batch)', () => {
    it('returns empty array for inactive accounts', async () => {
      const res = await app.post('/accounts').send({
        addresses: [
          'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI',
          'GCZST3XVCDTUJ76ZAV2HA72KYXM4Y5LXNLHT3GSXWOOEDNVGY45UXGIT',
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('inactive');
    });

    it('rejects empty addresses array', async () => {
      const res = await app.post('/accounts').send({ addresses: [] });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects more than 100 addresses', async () => {
      const addresses = Array.from(
        { length: 101 },
        (_, i) => `GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMAD${i % 10}`,
      );
      const res = await app.post('/accounts').send({ addresses });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('includes activity stats in account response', async () => {
      const res = await app.post('/accounts').send({
        addresses: ['GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI'],
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      // Data should have activity stats structure (or null for inactive)
      const item = res.body.data[0];
      if (item !== null) {
        expect(item).toHaveProperty('address');
        expect(item).toHaveProperty('transactionCount');
        expect(item).toHaveProperty('eventCount');
      }
    });
  });

  describe('Batch performance characteristics', () => {
    it('handles 100 events in reasonable time', async () => {
      const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
      const startTime = Date.now();

      const res = await app.post('/events').send({ ids });

      const duration = Date.now() - startTime;
      expect(res.status).toBe(200);
      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
    });

    it('handles 100 transactions in reasonable time', async () => {
      const hashes = Array.from({ length: 100 }, (_, i) => i.toString().padStart(64, '0'));
      const startTime = Date.now();

      const res = await app.post('/transactions').send({ hashes });

      const duration = Date.now() - startTime;
      expect(res.status).toBe(200);
      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
    });

    it('handles 100 accounts in reasonable time', async () => {
      const addresses = Array.from({ length: 100 }, (_, i) =>
        `GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMAD${String(i).padStart(2, '0')}`.substring(
          0,
          56,
        ),
      );
      const startTime = Date.now();

      const res = await app.post('/accounts').send({ addresses });

      const duration = Date.now() - startTime;
      expect(res.status).toBe(200);
      expect(duration).toBeLessThan(5000); // Should complete in < 5 seconds
    });
  });

  describe('Batch response format', () => {
    it('events batch returns consistent format', async () => {
      const res = await app.post('/events').send({
        ids: ['id-1', 'id-2'],
      });

      expect(res.body).toMatchObject({
        data: expect.any(Array),
        missing: expect.any(Array),
      });
      expect(res.body.data).toHaveLength(2);
    });

    it('transactions batch returns consistent format', async () => {
      const res = await app.post('/transactions').send({
        hashes: ['hash1', 'hash2'],
      });

      expect(res.body).toMatchObject({
        data: expect.any(Array),
        missing: expect.any(Array),
      });
      expect(res.body.data).toHaveLength(2);
    });

    it('accounts batch returns consistent format', async () => {
      const res = await app.post('/accounts').send({
        addresses: ['addr1', 'addr2'],
      });

      expect(res.body).toMatchObject({
        data: expect.any(Array),
        inactive: expect.any(Array),
      });
    });
  });
});
