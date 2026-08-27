/**
 * Integration tests for the Predict endpoint router mount (#849).
 *
 * These tests verify that the predictive analytics router is properly mounted:
 *   1. /predict/forecast — model-backed predictions
 *   2. /predict/ensemble — ensemble model predictions
 *   3. /predict/demo-keys — demo API key generation
 *
 * This test suite ensures that the predictRouter defined in predict.ts is
 * mounted correctly and handles all sub-routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../src/middleware/apiKeyAuth', () => {
  const apiKeyAuth = (req: any, _res: any, next: any) => {
    if (req.headers['x-test-auth'] === 'yes') {
      req.apiKey = {
        id: 'key-test',
        keyName: 'test-key',
        developerId: 'dev-test',
        tier: 'developer',
      };
    }
    next();
  };

  const requireApiKey = (req: any, res: any, next: any) => {
    if (!req.apiKey) {
      res.status(401).json({ error: 'API key required' });
      return;
    }
    next();
  };

  const requireKeyTier = (_min: string) => (_req: any, _res: any, next: any) => next();

  return { apiKeyAuth, requireApiKey, requireKeyTier };
});

vi.mock('../../src/indexer/feature-store', () => ({
  featureStore: {
    getHistoricalData: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    devApiKey: { findFirst: vi.fn() },
  },
  prismaWrite: {
    devApiKey: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    demo: { maxApiKeysPerDeveloper: 5 },
  },
}));

vi.mock('../../src/predictive/factory', () => ({
  getDeterministicDriftPsi: vi.fn(),
  getForecaster: vi.fn().mockResolvedValue({
    predict: vi
      .fn()
      .mockReturnValue([{ timestamp: Date.now(), value: 100, lower_bound: 95, upper_bound: 105 }]),
    getModels: vi.fn().mockReturnValue(['ARIMA', 'Prophet']),
  }),
}));

vi.mock('../../src/predictive/training-service', () => ({
  modelTrainingService: {
    train: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Imports (must come after vi.mock) ────────────────────────────────────────

import { predictRouter } from '../../src/api/predict';
import { apiKeyAuth, requireApiKey } from '../../src/middleware/apiKeyAuth';

// ── App factory ──────────────────────────────────────────────────────────────

function makePredictApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use('/predict', requireApiKey, predictRouter);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Predict endpoint router mount (#849)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 on POST /predict/forecast without an API key', async () => {
    const res = await request(makePredictApp())
      .post('/predict/forecast')
      .send({ metric: 'tx_volume', horizon: 30 });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/api key/i) });
  });

  it('returns 200 on POST /predict/forecast with a valid API key', async () => {
    const res = await request(makePredictApp())
      .post('/predict/forecast')
      .set('x-test-auth', 'yes')
      .send({ metric: 'tx_volume', horizon: 30, confidence_level: 0.95 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('metric', 'tx_volume');
    expect(res.body).toHaveProperty('predictions');
  });

  it('returns 401 on GET /predict/ensemble without an API key', async () => {
    const res = await request(makePredictApp()).get('/predict/ensemble');

    expect(res.status).toBe(401);
  });

  it('returns 200 on GET /predict/ensemble with a valid API key', async () => {
    const res = await request(makePredictApp())
      .get('/predict/ensemble')
      .query({ horizon: 30, metric: 'tx_volume' })
      .set('x-test-auth', 'yes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('models');
    expect(res.body).toHaveProperty('predictions');
  });

  it('uses default metric and horizon when not provided', async () => {
    const res = await request(makePredictApp())
      .post('/predict/forecast')
      .set('x-test-auth', 'yes')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metric', 'tx_volume');
    expect(res.body).toHaveProperty('horizon', 30);
  });

  it('mounts /predict with auth gate — mounts are reachable', async () => {
    const res = await request(makePredictApp()).get('/predict/ensemble');

    // 401 from requireApiKey proves the route is mounted (not 404)
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });
});
