import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../src/db', () => {
  const mockDb = {
    featureDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
    featureValue: { findMany: vi.fn().mockResolvedValue([]) },
    predictionScenario: { create: vi.fn() },
    predictiveApiKey: {
      create: vi.fn().mockImplementation((d: any) => Promise.resolve({ id: 'mock-id', ...d.data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { default: mockDb, prismaWrite: mockDb };
});

import { predictRouter } from '../src/api/predict';

const app = express();
app.use(express.json());
app.use('/api/v1/predict', predictRouter);

describe('Predictive Analytics Engine API', () => {
  it('should return basic forecasts', async () => {
    const res = await request(app).post('/api/v1/predict/forecast').send({
      metric: 'tx_volume',
      horizon: 14,
      confidence_level: 0.95,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.predictions).toBeDefined();
    expect(res.body.predictions.length).toBe(14);
  });

  it('should return ensemble details', async () => {
    const res = await request(app).get('/api/v1/predict/ensemble?horizon=7');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.models).toBeDefined();
    expect(res.body.models.length).toBeGreaterThan(0);
    expect(res.body.predictions.length).toBe(7);
  });

  it('should handle anomaly forecasts', async () => {
    const res = await request(app).post('/api/v1/predict/anomaly-forecast').send({
      metric: 'tx_volume',
      anomaly_value: 50000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message.toLowerCase()).toContain('recover');
    expect(res.body.predictions.length).toBe(14);
  });

  it('should generate api keys', async () => {
    const res = await request(app).post('/api/v1/predict/api-keys').send({ tier: 'pro' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.api_key).toBeDefined();
    expect(res.body.tier).toBe('pro');
  });
});
