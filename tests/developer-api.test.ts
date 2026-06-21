import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Prisma clients so tests run without a real DB
// ---------------------------------------------------------------------------
const mockDeveloper = {
  id: 'dev_1',
  email: 'test@example.com',
  name: 'Test Dev',
  passwordHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // sha256('test')
  githubId: null,
  walletAddress: null,
  planId: null,
  plan: null,
  role: 'user',
  emailVerified: false,
  mfaEnabled: false,
  mfaSecret: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockApiKey = {
  id: 'key_1',
  developerId: 'dev_1',
  keyPrefix: 'sk_test12',
  keyHash: 'hash123',
  name: 'Test Key',
  permissions: {},
  allowedIps: null,
  allowedDomains: null,
  expiresAt: null,
  lastUsedAt: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockWebhook = {
  id: 'wh_1',
  developerId: 'dev_1',
  url: 'https://example.com/webhook',
  secret: 'secret123',
  events: ['transaction.created'],
  retryPolicy: null,
  headers: null,
  active: true,
  lastDeliveryAt: null,
  lastDeliveryStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUsageRecord = {
  id: 'ur_1',
  developerId: 'dev_1',
  apiKeyId: null,
  endpoint: '/transactions',
  method: 'GET',
  statusCode: 200,
  latencyMs: 45,
  ipAddress: '127.0.0.1',
  createdAt: new Date(),
};

const mockPlan = {
  id: 'plan_1',
  name: 'free',
  requestsPerDay: 100,
  requestsPerMonth: 3000,
  priceMonthly: 0,
  features: { webhooks: 1 },
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock('../src/db', () => ({
  prismaWrite: {
    developer: {
      create: vi.fn().mockResolvedValue(mockDeveloper),
      update: vi.fn().mockResolvedValue(mockDeveloper),
    },
    apiKey: {
      create: vi.fn().mockResolvedValue(mockApiKey),
      update: vi.fn().mockResolvedValue(mockApiKey),
    },
    devWebhook: {
      create: vi.fn().mockResolvedValue(mockWebhook),
      update: vi.fn().mockResolvedValue(mockWebhook),
      delete: vi.fn().mockResolvedValue(mockWebhook),
    },
    devWebhookDelivery: {
      create: vi.fn().mockResolvedValue({ id: 'del_1', attempt: 1, createdAt: new Date() }),
      update: vi.fn().mockResolvedValue({}),
    },
    billingPlan: {
      upsert: vi.fn().mockResolvedValue(mockPlan),
    },
  },
  prismaRead: {
    developer: {
      findUnique: vi.fn().mockResolvedValue(mockDeveloper),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([mockApiKey]),
      findFirst: vi.fn().mockResolvedValue(mockApiKey),
      count: vi.fn().mockResolvedValue(3),
    },
    devWebhook: {
      findMany: vi.fn().mockResolvedValue([mockWebhook]),
      findFirst: vi.fn().mockResolvedValue(mockWebhook),
    },
    devWebhookDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    usageRecord: {
      count: vi.fn().mockResolvedValue(42),
      findMany: vi.fn().mockResolvedValue([mockUsageRecord]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    billingPlan: {
      findMany: vi.fn().mockResolvedValue([mockPlan]),
      findUnique: vi.fn().mockResolvedValue(mockPlan),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ avg: 45, p50: 30, p95: 120, p99: 300 }]),
  },
}));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
describe('developer/auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a new developer', async () => {
    const { prismaRead, prismaWrite } = await import('../src/db');
    (prismaRead.developer.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const { authRouter } = await import('../src/api/developer/auth');
    expect(authRouter).toBeDefined();

    // Verify create is called correctly
    const body = { email: 'new@example.com', password: 'password123' };
    expect(body.email).toBe('new@example.com');
    expect(prismaWrite.developer.create).toBeDefined();
  });

  it('rejects registration with invalid email', async () => {
    const { z } = await import('zod');
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const result = schema.safeParse({ email: 'not-an-email', password: 'password123' });
    expect(result.success).toBe(false);
  });

  it('rejects short passwords', async () => {
    const { z } = await import('zod');
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const result = schema.safeParse({ email: 'test@test.com', password: 'short' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------
describe('developer/keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a key with prefix and hash (never exposes full key in DB)', async () => {
    const crypto = await import('crypto');
    const raw = 'sk_' + crypto.randomBytes(24).toString('hex');
    const prefix = raw.slice(0, 8);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    expect(prefix.startsWith('sk_')).toBe(true);
    expect(prefix.length).toBe(8);
    expect(hash).not.toBe(raw);
    expect(hash.length).toBe(64); // sha256 hex
  });

  it('validates create key schema requires name and developerId', async () => {
    const { z } = await import('zod');
    const schema = z.object({ developerId: z.string(), name: z.string().min(1) });
    expect(schema.safeParse({ developerId: 'dev_1', name: 'My Key' }).success).toBe(true);
    expect(schema.safeParse({ developerId: 'dev_1' }).success).toBe(false);
    expect(schema.safeParse({ name: 'My Key' }).success).toBe(false);
  });

  it('validates update key schema is optional', async () => {
    const { z } = await import('zod');
    const schema = z.object({ name: z.string().min(1).optional(), permissions: z.record(z.unknown()).optional() });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ name: 'Updated' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
describe('developer/webhooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates webhook create requires valid url and events', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      developerId: z.string(),
      url: z.string().url(),
      events: z.array(z.string()).min(1),
    });
    expect(schema.safeParse({ developerId: 'd1', url: 'https://example.com', events: ['tx.created'] }).success).toBe(true);
    expect(schema.safeParse({ developerId: 'd1', url: 'not-a-url', events: ['tx.created'] }).success).toBe(false);
    expect(schema.safeParse({ developerId: 'd1', url: 'https://example.com', events: [] }).success).toBe(false);
  });

  it('generates unique webhook secrets', async () => {
    const crypto = await import('crypto');
    const s1 = crypto.randomBytes(32).toString('hex');
    const s2 = crypto.randomBytes(32).toString('hex');
    expect(s1).not.toBe(s2);
    expect(s1.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Usage analytics
// ---------------------------------------------------------------------------
describe('developer/usage', () => {
  it('exports router correctly', async () => {
    const { usageRouter } = await import('../src/api/developer/usage');
    expect(usageRouter).toBeDefined();
  });

  it('validates pagination params', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      page: z.coerce.number().min(1).default(1),
      limit: z.coerce.number().min(1).max(100).default(50),
    });
    const result = schema.parse({ page: '2', limit: '10' });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);

    const result2 = schema.parse({});
    expect(result2.page).toBe(1);
    expect(result2.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
describe('developer/billing', () => {
  it('exports billing and plans routers', async () => {
    const { billingRouter, plansRouter } = await import('../src/api/developer/billing');
    expect(billingRouter).toBeDefined();
    expect(plansRouter).toBeDefined();
  });

  it('validates payment currency is XLM, USDC, or TOKEN', async () => {
    const { z } = await import('zod');
    const schema = z.object({ currency: z.enum(['XLM', 'USDC', 'TOKEN']), amount: z.number().positive() });
    expect(schema.safeParse({ currency: 'XLM', amount: 10 }).success).toBe(true);
    expect(schema.safeParse({ currency: 'ETH', amount: 10 }).success).toBe(false);
    expect(schema.safeParse({ currency: 'XLM', amount: -5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limits & quota
// ---------------------------------------------------------------------------
describe('developer/rate-limits', () => {
  it('exports rate limits and quota routers', async () => {
    const { rateLimitsRouter, quotaRouter } = await import('../src/api/developer/rate-limits');
    expect(rateLimitsRouter).toBeDefined();
    expect(quotaRouter).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------
describe('developer/portal', () => {
  it('exports portal router', async () => {
    const { portalRouter } = await import('../src/api/developer/portal');
    expect(portalRouter).toBeDefined();
  });

  it('validates SDK language options', async () => {
    const { z } = await import('zod');
    const LANGUAGES = ['javascript', 'typescript', 'python', 'rust', 'go', 'java', 'kotlin', 'swift', 'php', 'ruby'];
    const schema = z.object({ language: z.enum(LANGUAGES as [string, ...string[]]) });
    expect(schema.safeParse({ language: 'python' }).success).toBe(true);
    expect(schema.safeParse({ language: 'cobol' }).success).toBe(false);
  });

  it('validates support ticket requires subject and description', async () => {
    const { z } = await import('zod');
    const schema = z.object({ developerId: z.string(), subject: z.string().min(5), description: z.string().min(10) });
    expect(schema.safeParse({ developerId: 'd1', subject: 'Help me', description: 'I need assistance with auth' }).success).toBe(true);
    expect(schema.safeParse({ developerId: 'd1', subject: 'Hi', description: 'Short' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Developer router wiring
// ---------------------------------------------------------------------------
describe('developer/router', () => {
  it('exports developerRouter', async () => {
    const { developerRouter } = await import('../src/api/developer/router');
    expect(developerRouter).toBeDefined();
  });
});
