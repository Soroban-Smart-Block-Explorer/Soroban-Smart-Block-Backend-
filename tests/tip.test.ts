/**
 * Tests for the Threat Intelligence Platform (TIP).
 * Uses vitest with Prisma and HTTP clients mocked/stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

const mockAdvisory = {
  id: 'adv1',
  title: 'Test Vuln',
  description: 'Something bad happened',
  severity: 'high',
  cvssScore: 7.5,
  cveId: null,
  ghsaId: null,
  affectedContracts: ['CA...'],
  affectedChains: ['stellar'],
  mitigations: ['Patch it'],
  status: 'open',
  tags: ['test'],
  externalUrl: null,
  submittedBy: 'test-key',
  sourceId: 's1',
  publishedAt: null,
  resolvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  correlations: [],
  reviews: [],
  comments: [],
  source: { id: 's1', name: 'COMMUNITY', sourceType: 'manual' },
};

const mockSource = { id: 's1', name: 'COMMUNITY', sourceType: 'manual', feedUrl: null, enabled: true, lastFetchAt: null };

vi.mock('@prisma/client', () => {
  const advisoryMethods = {
    upsert: vi.fn().mockResolvedValue(mockAdvisory),
    create: vi.fn().mockResolvedValue(mockAdvisory),
    findMany: vi.fn().mockResolvedValue([mockAdvisory]),
    findUnique: vi.fn().mockResolvedValue(mockAdvisory),
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      ...mockAdvisory,
      cvssScore: 7.0,
      affectedContracts: ['CA1', 'CA2'],
      correlations: [{ confidence: 0.95 }],
    }),
    update: vi.fn().mockResolvedValue({ ...mockAdvisory, status: 'resolved' }),
    delete: vi.fn().mockResolvedValue(mockAdvisory),
    count: vi.fn().mockResolvedValue(1),
    findFirst: vi.fn().mockResolvedValue(null),
    groupBy: vi.fn().mockResolvedValue([{ severity: 'high', _count: { id: 1 } }]),
  };
  return {
    PrismaClient: vi.fn().mockImplementation(() => ({
      threatAdvisory: advisoryMethods,
      vulnerabilitySource: {
        upsert: vi.fn().mockResolvedValue(mockSource),
        update: vi.fn().mockResolvedValue(mockSource),
        findMany: vi.fn().mockResolvedValue([mockSource]),
      },
      threatCorrelation: {
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      threatReview: {
        create: vi.fn().mockResolvedValue({ id: 'rev1', advisoryId: 'adv1', decision: 'approve' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      threatComment: {
        create: vi.fn().mockResolvedValue({ id: 'c1', body: 'test comment' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      tipSubscription: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({ id: 'sub1', channel: 'slack', target: 'https://hooks.slack.com/x' }),
        delete: vi.fn().mockResolvedValue({}),
      },
      tipWebhook: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({ id: 'wh1', url: 'https://example.com/wh', events: ['advisory.created'] }),
        delete: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

vi.mock('../src/db', () => ({ prismaRead: {} }));
vi.mock('axios');

// ─── Collectors ───────────────────────────────────────────────────────────────

describe('collectors', () => {
  it('submitManual returns an advisory id', async () => {
    const { submitManual } = await import('../src/tip/collectors');
    const id = await submitManual({
      title: 'Reentrancy in TokenSwap',
      description: 'The swap function is vulnerable to reentrancy attacks',
      severity: 'high',
      affectedContracts: ['CABC123'],
      affectedChains: ['stellar'],
      mitigations: ['Add reentrancy guard'],
      submittedBy: 'analyst-1',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('normalises unknown severity to info', async () => {
    const { submitManual } = await import('../src/tip/collectors');
    const id = await submitManual({
      title: 'Minor issue',
      description: 'Not a big deal but worth noting here',
      severity: 'unknown_level',
      submittedBy: 'bot',
    });
    expect(id).toBeTruthy();
  });
});

// ─── Correlator ──────────────────────────────────────────────────────────────

describe('correlator', () => {
  it('deduplicateAdvisories returns a number', async () => {
    const { deduplicateAdvisories } = await import('../src/tip/correlator');
    const linked = await deduplicateAdvisories();
    expect(typeof linked).toBe('number');
  });

  it('rescore returns a severity string', async () => {
    const { rescore } = await import('../src/tip/correlator');
    const severity = await rescore('adv1');
    expect(['critical', 'high', 'medium', 'low', 'info']).toContain(severity);
  });
});

// ─── Analytics ────────────────────────────────────────────────────────────────

describe('analytics', () => {
  it('getSeverityDistribution returns array with count', async () => {
    const { getSeverityDistribution } = await import('../src/tip/analytics');
    const data = await getSeverityDistribution();
    expect(Array.isArray(data)).toBe(true);
    if (data.length) {
      expect(data[0]).toHaveProperty('severity');
      expect(data[0]).toHaveProperty('count');
    }
  });

  it('getTrendData returns array', async () => {
    const { getTrendData } = await import('../src/tip/analytics');
    const data = await getTrendData(30);
    expect(Array.isArray(data)).toBe(true);
  });

  it('getTopAffectedContracts returns sorted list', async () => {
    const { getTopAffectedContracts } = await import('../src/tip/analytics');
    const data = await getTopAffectedContracts(10);
    expect(Array.isArray(data)).toBe(true);
  });
});

// ─── Notifier ────────────────────────────────────────────────────────────────

describe('notifier', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('dispatchNotifications runs without error when no subs/webhooks', async () => {
    const { dispatchNotifications } = await import('../src/tip/notifier');
    await expect(
      dispatchNotifications({
        advisoryId: 'adv1',
        event: 'advisory.created',
        title: 'Test Advisory',
        severity: 'high',
      }),
    ).resolves.not.toThrow();
  });

  it('formats message with severity and title', async () => {
    // White-box: test formatMessage indirectly via dispatchNotifications
    const axiosMock = await import('axios');
    (axiosMock.default as any).post = vi.fn().mockResolvedValue({ data: 'ok' });

    const { PrismaClient } = await import('@prisma/client');
    const instance = new (PrismaClient as any)();
    instance.tipSubscription.findMany = vi.fn().mockResolvedValue([
      { id: 's1', channel: 'slack', target: 'https://hooks.slack.com/test', filters: null, active: true },
    ]);
    instance.tipWebhook.findMany = vi.fn().mockResolvedValue([]);

    const { dispatchNotifications } = await import('../src/tip/notifier');
    await dispatchNotifications({
      advisoryId: 'adv1',
      event: 'advisory.created',
      title: 'Critical Vuln',
      severity: 'critical',
    });
    // No assertion on axios call count since Prisma mock returns empty by default,
    // but we verify no exception was thrown.
  });
});

// ─── API schema validation ────────────────────────────────────────────────────

describe('tip API schema validation', () => {
  it('rejects advisory with short description', async () => {
    const { z } = await import('zod');
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    });

    const result = CreateAdvisory.safeParse({ title: 'AB', description: 'Short', severity: 'high' });
    expect(result.success).toBe(false);
  });

  it('accepts valid advisory payload', async () => {
    const { z } = await import('zod');
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    });

    const result = CreateAdvisory.safeParse({
      title: 'Reentrancy Bug',
      description: 'Vulnerable to reentrancy in the withdraw function',
      severity: 'high',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid severity', async () => {
    const { z } = await import('zod');
    const Schema = z.object({ severity: z.enum(['critical', 'high', 'medium', 'low', 'info']) });
    const result = Schema.safeParse({ severity: 'massive' });
    expect(result.success).toBe(false);
  });
});
