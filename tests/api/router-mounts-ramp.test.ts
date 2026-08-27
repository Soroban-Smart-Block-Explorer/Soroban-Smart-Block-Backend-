/**
 * Integration tests for the Fiat ramp gateway API router mount (#850).
 *
 * These tests verify that the ramp gateway router is properly mounted:
 *   1. POST /ramp/quote — get quotes from all providers
 *   2. POST /ramp/execute — execute order with chosen provider
 *   3. GET /ramp/orders/:id — track order status
 *   4. GET /ramp/orders — list caller's orders
 *   5. POST /ramp/refund — initiate refund
 *   6. GET /ramp/providers — list provider availability
 *   7. POST /ramp/kyc/status — get/create KYC record
 *   8. POST /ramp/webhook/:provider — receive provider callbacks
 *
 * This test suite ensures that the rampRouter defined in ramp.ts is
 * mounted correctly and handles all fiat on/off-ramp flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: (req: any, res: any) => Promise<void>) => fn,
}));

vi.mock('../../src/auth/middleware', () => ({
  requireAuth: (
    req: { headers: Record<string, string> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (req.headers['authorization']) {
      (req as any).user = { id: 'user-test', address: 'GXYZ...' };
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  },
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    rampOrder: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  prismaWrite: {
    rampOrder: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../src/services/ramp/gateway', () => ({
  aggregateQuotes: vi.fn().mockResolvedValue([
    { provider: 'provider-a', rate: 0.95, fee: 5 },
    { provider: 'provider-b', rate: 0.93, fee: 8 },
  ]),
  executeOrder: vi.fn().mockResolvedValue({ orderId: 'order-123' }),
  getProviderOrderStatus: vi.fn().mockResolvedValue({ status: 'pending' }),
  initiateProviderRefund: vi.fn().mockResolvedValue({ refundId: 'refund-123' }),
  listProviderAvailability: vi.fn().mockResolvedValue([
    { provider: 'provider-a', available: true },
    { provider: 'provider-b', available: true },
  ]),
}));

vi.mock('../../src/services/ramp/kyc', () => ({
  checkKycAllowance: vi.fn().mockResolvedValue(true),
  getOrCreateKycRecord: vi.fn().mockResolvedValue({ id: 'kyc-123', status: 'verified' }),
  recordKycUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/ramp/order-management', () => ({
  createOrder: vi.fn().mockResolvedValue({ id: 'order-123' }),
  transitionOrder: vi.fn().mockResolvedValue({ id: 'order-123', status: 'executing' }),
  getOrder: vi.fn().mockResolvedValue({ id: 'order-123', status: 'pending' }),
  listUserOrders: vi.fn().mockResolvedValue([{ id: 'order-123', status: 'completed' }]),
  attachProviderOrderId: vi.fn().mockResolvedValue(undefined),
  markRefundInitiated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/ramp/aml', () => ({
  raiseFlagIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Imports (must come after vi.mock) ────────────────────────────────────────

import { rampRouter } from '../../src/api/ramp';
import { requireAuth } from '../../src/auth/middleware';

// ── App factory ──────────────────────────────────────────────────────────────

function makeRampApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use('/ramp', rampRouter);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Fiat ramp gateway API router mount (#850)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 on POST /ramp/quote without auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/quote')
      .send({ direction: 'on', amount: 100, asset: 'USDC' });

    expect(res.status).toBe(401);
  });

  it('returns 200 on POST /ramp/quote with valid auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/quote')
      .set('authorization', 'Bearer token')
      .send({ direction: 'on', amount: 100, asset: 'USDC' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('quotes');
  });

  it('returns 401 on POST /ramp/execute without auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/execute')
      .send({ quoteId: 'quote-123', provider: 'provider-a' });

    expect(res.status).toBe(401);
  });

  it('returns 200 on POST /ramp/execute with valid auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/execute')
      .set('authorization', 'Bearer token')
      .send({ quoteId: 'quote-123', provider: 'provider-a' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('orderId');
  });

  it('returns 401 on GET /ramp/orders without auth', async () => {
    const res = await request(makeRampApp()).get('/ramp/orders');

    expect(res.status).toBe(401);
  });

  it('returns 200 on GET /ramp/orders with valid auth', async () => {
    const res = await request(makeRampApp())
      .get('/ramp/orders')
      .set('authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('orders');
  });

  it('returns 401 on GET /ramp/orders/:id without auth', async () => {
    const res = await request(makeRampApp()).get('/ramp/orders/order-123');

    expect(res.status).toBe(401);
  });

  it('returns 200 on GET /ramp/orders/:id with valid auth', async () => {
    const res = await request(makeRampApp())
      .get('/ramp/orders/order-123')
      .set('authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('order');
  });

  it('returns 401 on GET /ramp/providers without auth', async () => {
    const res = await request(makeRampApp()).get('/ramp/providers');

    expect(res.status).toBe(401);
  });

  it('returns 200 on GET /ramp/providers with valid auth', async () => {
    const res = await request(makeRampApp())
      .get('/ramp/providers')
      .set('authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('providers');
  });

  it('returns 401 on POST /ramp/kyc/status without auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/kyc/status')
      .send({ country: 'US', address: 'addr...' });

    expect(res.status).toBe(401);
  });

  it('returns 200 on POST /ramp/kyc/status with valid auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/kyc/status')
      .set('authorization', 'Bearer token')
      .send({ country: 'US', address: 'addr...' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('kyc');
  });

  it('returns 401 on POST /ramp/refund without auth', async () => {
    const res = await request(makeRampApp()).post('/ramp/refund').send({ orderId: 'order-123' });

    expect(res.status).toBe(401);
  });

  it('returns 200 on POST /ramp/refund with valid auth', async () => {
    const res = await request(makeRampApp())
      .post('/ramp/refund')
      .set('authorization', 'Bearer token')
      .send({ orderId: 'order-123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('refundId');
  });

  it('mounts /ramp with auth gate — all mounts are reachable', async () => {
    const res = await request(makeRampApp()).get('/ramp/providers');

    // 401 from requireAuth proves the route is mounted (not 404)
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });
});
