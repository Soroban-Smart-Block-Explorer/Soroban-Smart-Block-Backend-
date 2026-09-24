import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaWrite: {
    webhookSubscription: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  prismaRead: {
    webhookSubscription: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    webhookDelivery: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

vi.mock('../src/middleware/apiKeyAuth', () => ({
  apiKeyAuth: (req: { apiKey?: unknown }, _res: unknown, next: () => void) => {
    req.apiKey = { id: 'test-api-key' };
    next();
  },
  requireApiKey: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/middleware/sensitiveReadLog', () => ({
  sensitiveReadLog: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/webhooks/ssrf-guard', () => {
  class SsrfBlockedError extends Error {
    constructor(reason: string) {
      super(`SSRF blocked: ${reason}`);
      this.name = 'SsrfBlockedError';
    }
  }
  return {
    SsrfBlockedError,
    assertSafeUrl: vi.fn(async () => ['93.184.216.34']),
    safePost: vi.fn(),
    safeGet: vi.fn(),
  };
});

import { prismaWrite, prismaRead } from '../src/db';
import { assertSafeUrl, safePost, SsrfBlockedError } from '../src/webhooks/ssrf-guard';
import { webhooksRouter } from '../src/api/webhooks';

const app = express();
app.use(express.json());
app.use('/webhooks', webhooksRouter);

const SUB = {
  id: 'sub-1',
  apiKeyId: 'test-api-key',
  url: 'https://example.com/hook',
  secret: 'supersecret-0123456789abcdefghijklmnop',
  contractAddress: null,
  eventType: null,
  topicSymbol: null,
  active: true,
  storeResponseBody: true,
  responseRetentionDays: 90,
  verified: false,
  verifiedAt: null,
  verificationToken: null,
  verificationExpiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const writeSub = prismaWrite.webhookSubscription as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const writeDelivery = prismaWrite.webhookDelivery as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const readSub = prismaRead.webhookSubscription as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

beforeEach(() => {
  vi.clearAllMocks();
  (assertSafeUrl as ReturnType<typeof vi.fn>).mockResolvedValue(['93.184.216.34']);
});

// ── POST /:id/verify ──────────────────────────────────────────────────────────

describe('POST /webhooks/:id/verify', () => {
  it('verifies a subscription when the endpoint echoes the challenge', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue({ ...SUB, verified: true });

    let sentChallenge = '';
    (safePost as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, body: string) => {
        sentChallenge = JSON.parse(body).challenge;
        return { status: 200, data: { challenge: sentChallenge } };
      },
    );

    const res = await request(app).post('/webhooks/sub-1/verify');

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(sentChallenge).toMatch(/^[0-9a-f]{64}$/);

    // The stored token must be the digest, never the plaintext challenge.
    const persisted = writeSub.update.mock.calls[0][0];
    expect(persisted.data.verificationToken).not.toBe(sentChallenge);
    expect(persisted.data.verificationToken).toMatch(/^[0-9a-f]{64}$/);

    // Second update marks the subscription verified and clears the challenge.
    const finalUpdate = writeSub.update.mock.calls[1][0];
    expect(finalUpdate.data.verified).toBe(true);
    expect(finalUpdate.data.verificationToken).toBeNull();
  });

  it('accepts a plain-text challenge echo', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue(SUB);
    (safePost as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, body: string) =>
        ({ status: 200, data: JSON.parse(body).challenge }) as const,
    );

    const res = await request(app).post('/webhooks/sub-1/verify');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  it('rejects when the endpoint does not echo the challenge', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue(SUB);
    (safePost as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
      data: { challenge: 'not-the-right-value' },
    });

    const res = await request(app).post('/webhooks/sub-1/verify');
    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
  });

  it('returns 502 when the endpoint responds non-2xx', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue(SUB);
    (safePost as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500, data: 'boom' });

    const res = await request(app).post('/webhooks/sub-1/verify');
    expect(res.status).toBe(502);
    expect(res.body.verified).toBe(false);
  });

  it('returns 404 for a subscription the caller does not own', async () => {
    readSub.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/webhooks/sub-1/verify');
    expect(res.status).toBe(404);
  });
});

// ── POST /:id/ping ────────────────────────────────────────────────────────────

describe('POST /webhooks/:id/ping', () => {
  it('sends a signed synthetic event and records it', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeDelivery.create.mockResolvedValue({ id: 'del-1' });
    writeDelivery.update.mockResolvedValue({});
    (safePost as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 200, data: 'ok' });

    const res = await request(app).post('/webhooks/sub-1/ping');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.httpStatus).toBe(200);
    expect(res.body.deliveryId).toBe('del-1');

    // No retry is scheduled for a test send.
    const update = writeDelivery.update.mock.calls[0][0];
    expect(update.data.status).toBe('success');
    expect(update.data.nextRetryAt).toBeNull();

    // Delivery is signed.
    const headers = (safePost as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('returns 400 and does not call the destination when the URL is blocked', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeDelivery.create.mockResolvedValue({ id: 'del-2' });
    writeDelivery.update.mockResolvedValue({});
    (assertSafeUrl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SsrfBlockedError('private IP'),
    );

    const res = await request(app).post('/webhooks/sub-1/ping');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.blocked).toBe(true);
    expect(safePost).not.toHaveBeenCalled();
    // The blocked attempt is still recorded.
    expect(writeDelivery.update).toHaveBeenCalled();
  });

  it('returns 404 for unknown subscriptions', async () => {
    readSub.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/webhooks/sub-999/ping');
    expect(res.status).toBe(404);
  });
});

// ── GET /:id/preview ──────────────────────────────────────────────────────────

describe('GET /webhooks/:id/preview', () => {
  it('returns a signed sample envelope', async () => {
    readSub.findFirst.mockResolvedValue(SUB);

    const res = await request(app).get('/webhooks/sub-1/preview');

    expect(res.status).toBe(200);
    expect(res.body.delivery.headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(res.body.delivery.headers['X-Webhook-Timestamp']).toMatch(/^\d+$/);
    expect(res.body.rawBody).toBe(JSON.stringify(res.body.delivery.body));
    expect(res.body.delivery.body.attempt).toBe(1);
    expect(res.body.delivery.body.event.eventType).toBe('transfer');
  });

  it('reflects the subscription filters in the sample event', async () => {
    readSub.findFirst.mockResolvedValue({
      ...SUB,
      contractAddress: 'CXYZ123',
      eventType: 'mint',
      topicSymbol: 'TOK',
    });

    const res = await request(app).get('/webhooks/sub-1/preview');
    expect(res.status).toBe(200);
    expect(res.body.delivery.body.event.contractAddress).toBe('CXYZ123');
    expect(res.body.delivery.body.event.eventType).toBe('mint');
    expect(res.body.delivery.body.event.topicSymbol).toBe('TOK');
  });
});

// ── GET /sdk ──────────────────────────────────────────────────────────────────

describe('GET /webhooks/sdk', () => {
  it('returns integration guidance and verification snippets', async () => {
    const res = await request(app).get('/webhooks/sdk');

    expect(res.status).toBe(200);
    expect(res.body.snippets.typescript).toContain('timingSafeEqual');
    expect(res.body.snippets.python).toContain('hmac');
    expect(res.body.snippets.go).toContain('hmac.Equal');
    expect(typeof res.body.verification.toleranceMs).toBe('number');
    expect(res.body.retryPolicy.maxAttempts).toBeGreaterThan(0);
    expect(res.body.endpoints.verify).toContain('/verify');
  });
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────

describe('PATCH /webhooks/:id', () => {
  it('rejects an empty update body with 400 (not a mis-reported 404)', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    const res = await request(app).patch('/webhooks/sub-1').send({});
    expect(res.status).toBe(400);
  });

  it('resets verification when the URL changes', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue({
      ...SUB,
      url: 'https://new.example.com/hook',
      verified: false,
    });

    const res = await request(app)
      .patch('/webhooks/sub-1')
      .send({ url: 'https://new.example.com/hook' });

    expect(res.status).toBe(200);
    const update = writeSub.update.mock.calls[0][0];
    expect(update.data.url).toBe('https://new.example.com/hook');
    expect(update.data.verified).toBe(false);
    expect(update.data.verificationToken).toBeNull();
  });

  it('cancels pending deliveries when deactivated', async () => {
    readSub.findFirst.mockResolvedValue(SUB);
    writeSub.update.mockResolvedValue({ ...SUB, active: false });
    writeDelivery.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(app).patch('/webhooks/sub-1').send({ active: false });

    expect(res.status).toBe(200);
    expect(writeDelivery.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-1', status: 'pending' },
      data: {
        status: 'cancelled',
        processingStatus: 'done',
        leaseExpiresAt: null,
        nextRetryAt: null,
      },
    });
  });

  it('returns 404 for a subscription the caller does not own', async () => {
    readSub.findFirst.mockResolvedValue(null);
    const res = await request(app).patch('/webhooks/sub-1').send({ active: false });
    expect(res.status).toBe(404);
  });
});
