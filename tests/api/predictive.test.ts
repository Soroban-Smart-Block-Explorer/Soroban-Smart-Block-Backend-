import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db', () => ({
  default: {
    featureDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
    featureValue: { findMany: vi.fn().mockResolvedValue([]) },
    predictionScenario: {
      create: vi
        .fn()
        .mockImplementation((d: any) => Promise.resolve({ id: 'scenario-1', ...d.data })),
    },
    predictiveApiKey: {
      create: vi.fn().mockImplementation((d: any) => Promise.resolve({ id: 'key-1', ...d.data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: { count: vi.fn().mockResolvedValue(42) },
    featureValue: {
      findMany: vi.fn().mockResolvedValue([{ value: 1000 }, { value: 1050 }, { value: 980 }]),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    featureDefinition: {
      findUnique: vi.fn().mockResolvedValue({ id: 'fd-1' }),
      upsert: vi.fn().mockImplementation((d: any) => Promise.resolve({ id: 'fd-1', ...d.create })),
    },
  },
  prismaRead: {
    featureValue: { findMany: vi.fn().mockResolvedValue([]) },
    featureDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  prismaWrite: {
    featureValue: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([{ value: 1000 }, { value: 1050 }, { value: 980 }]),
    },
    featureDefinition: {
      findUnique: vi.fn().mockResolvedValue({ id: 'fd-1' }),
      upsert: vi.fn().mockImplementation((d: any) => Promise.resolve({ id: 'fd-1', ...d.create })),
    },
    predictionScenario: {
      create: vi
        .fn()
        .mockImplementation((d: any) => Promise.resolve({ id: 'scenario-1', ...d.data })),
    },
    predictiveApiKey: {
      create: vi.fn().mockImplementation((d: any) => Promise.resolve({ id: 'key-1', ...d.data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: { count: vi.fn().mockResolvedValue(0) },
  },
}));

import { predictRouter } from '../../src/api/predict';
import { resetForecasterForTests } from '../../src/predictive/factory';

const app = express();
app.use(express.json());
app.use('/api/v1/predict', predictRouter);

describe('Predictive Analytics API (/predict)', () => {
  beforeEach(() => {
    resetForecasterForTests();
  });
  it('POST /forecast returns predictions array of requested length', async () => {
    const res = await request(app).post('/api/v1/predict/forecast').send({
      metric: 'tx_volume',
      horizon: 14,
      confidence_level: 0.95,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.predictions)).toBe(true);
    expect(res.body.predictions).toHaveLength(14);
  });

  it('GET /ensemble returns model list and predictions', async () => {
    const res = await request(app).get('/api/v1/predict/ensemble?horizon=7');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.length).toBeGreaterThan(0);
    expect(res.body.predictions).toHaveLength(7);
  });

  it('GET /ensemble/:metric scopes predictions to metric', async () => {
    const res = await request(app).get('/api/v1/predict/ensemble/contract_calls?horizon=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metric).toBe('contract_calls');
    expect(res.body.predictions).toHaveLength(10);
  });

  it('GET /models returns available model list', async () => {
    const res = await request(app).get('/api/v1/predict/models');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.models)).toBe(true);
  });

  it('POST /anomaly-forecast returns recovery message and predictions', async () => {
    const res = await request(app).post('/api/v1/predict/anomaly-forecast').send({
      metric: 'tx_volume',
      anomaly_value: 50000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(Array.isArray(res.body.predictions)).toBe(true);
    expect(res.body.predictions).toHaveLength(14);
  });

  it('GET /anomaly-forecasts returns empty list', async () => {
    const res = await request(app).get('/api/v1/predict/anomaly-forecasts');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.forecasts)).toBe(true);
  });

  it('GET /accuracy/:metric returns accuracy metrics', async () => {
    const res = await request(app).get('/api/v1/predict/accuracy/tx_volume');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metric).toBe('tx_volume');
    expect(res.body.accuracy).toHaveProperty('mape');
    expect(res.body.accuracy).toHaveProperty('rmse');
  });

  it('GET /drift returns drift status per model', async () => {
    const res = await request(app).get('/api/v1/predict/drift');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.drift_status)).toBe(true);
  });

  it('GET /dashboard/overview returns summary cards and timeseries', async () => {
    const res = await request(app).get('/api/v1/predict/dashboard/overview');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.summaryCards)).toBe(true);
    expect(res.body.timeseries).toHaveProperty('historical');
    expect(res.body.timeseries).toHaveProperty('forecast');
  });

  it('POST /api-keys creates a key with correct tier', async () => {
    const res = await request(app).post('/api/v1/predict/api-keys').send({ tier: 'pro' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.api_key).toBeDefined();
    expect(res.body.tier).toBe('pro');
  });

  it('GET /api-keys returns key list', async () => {
    const res = await request(app).get('/api/v1/predict/api-keys');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.keys)).toBe(true);
  });
});
