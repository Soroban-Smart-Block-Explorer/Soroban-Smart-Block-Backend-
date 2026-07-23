import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as db from '../../src/db';

vi.mock('../../src/db', () => ({
  prismaRead: {
    gasAnalyticsSnapshot: { findMany: vi.fn() },
  },
}));

vi.mock('../../src/indexer/gasAnalytics', () => ({
  runGasAnalytics: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/api/protocol-economics', () => ({
  protocolEconomicsRouter: express.Router(),
}));

import { analyticsRouter } from '../../src/api/analytics';
import { runGasAnalytics } from '../../src/indexer/gasAnalytics';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/analytics', analyticsRouter);
  return app;
}

describe('GET /analytics/gas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns snapshots for default day bucket', async () => {
    vi.mocked(db.prismaRead.gasAnalyticsSnapshot.findMany).mockResolvedValue([
      { bucket: 'day', bucketStart: new Date(), avgFee: 200 },
    ] as any);

    const res = await request(makeApp()).get('/analytics/gas');
    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('day');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns snapshots for hour bucket', async () => {
    vi.mocked(db.prismaRead.gasAnalyticsSnapshot.findMany).mockResolvedValue([]);

    const res = await request(makeApp()).get('/analytics/gas?bucket=hour&limit=24');
    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('hour');
    expect(db.prismaRead.gasAnalyticsSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bucket: 'hour' }, take: 24 }),
    );
  });

  it('returns 400 for invalid bucket value', async () => {
    const res = await request(makeApp()).get('/analytics/gas?bucket=month');
    expect(res.status).toBe(400);
  });

  it('returns 400 for limit exceeding max (500)', async () => {
    const res = await request(makeApp()).get('/analytics/gas?limit=9999');
    expect(res.status).toBe(400);
  });
});

describe('POST /analytics/gas/run', () => {
  beforeEach(() => vi.clearAllMocks());

  it('triggers gas analytics and returns ok', async () => {
    const res = await request(makeApp()).post('/analytics/gas/run');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runGasAnalytics).toHaveBeenCalledOnce();
  });

  it('returns 500 when runGasAnalytics throws', async () => {
    vi.mocked(runGasAnalytics).mockRejectedValueOnce(new Error('DB down'));

    const res = await request(makeApp()).post('/analytics/gas/run');
    expect(res.status).toBe(500);
  });
});
