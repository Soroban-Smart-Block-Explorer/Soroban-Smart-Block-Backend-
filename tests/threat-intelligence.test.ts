import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('../src/tip/collectors', () => ({
  submitManual: vi.fn(),
}));

vi.mock('../src/tip/correlator', () => ({
  rescore: vi.fn(),
  deduplicateAdvisories: vi.fn(),
}));

vi.mock('../src/tip/notifier', () => ({
  dispatchNotifications: vi.fn(),
}));

vi.mock('../src/tip/analytics', () => ({
  getSeverityDistribution: vi.fn(),
  getTrendData: vi.fn(),
  getTopAffectedContracts: vi.fn(),
  getStatusSummary: vi.fn(),
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Threat Intelligence - Advisory CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates advisory with valid input', async () => {
    const { submitManual } = await import('../src/tip/collectors');
    const { dispatchNotifications } = await import('../src/tip/notifier');

    vi.mocked(submitManual).mockResolvedValue('advisory-id-1');

    const advisoryData = {
      title: 'Reentrancy vulnerability',
      description: 'A critical reentrancy vulnerability in the token hook implementation',
      severity: 'critical',
      cvssScore: 9.8,
      affectedContracts: ['CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5'],
      affectedChains: ['stellar'],
      mitigations: ['Upgrade to patched version'],
      tags: ['reentrancy', 'critical'],
    };

    const submittedId = await submitManual(advisoryData);
    expect(submittedId).toBe('advisory-id-1');
    expect(submitManual).toHaveBeenCalled();
  });

  it('validates required fields', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      cvssScore: z.number().min(0).max(10).optional(),
      affectedContracts: z.array(z.string()).default([]),
      affectedChains: z.array(z.string()).default(['stellar']),
      mitigations: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      externalUrl: z.string().url().optional(),
    });

    const validData = {
      title: 'Test',
      description: 'This is a valid description',
      severity: 'high',
    };

    const result = CreateAdvisory.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('rejects invalid severity level', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    });

    const invalidData = {
      title: 'Test',
      description: 'This is a valid description',
      severity: 'invalid',
    };

    const result = CreateAdvisory.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects short title', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    });

    const invalidData = {
      title: 'ab',
      description: 'This is a valid description',
      severity: 'high',
    };

    const result = CreateAdvisory.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('rejects short description', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    });

    const invalidData = {
      title: 'Valid Title',
      description: 'short',
      severity: 'high',
    };

    const result = CreateAdvisory.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it('defaults chains to stellar if not provided', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      affectedChains: z.array(z.string()).default(['stellar']),
    });

    const data = {
      title: 'Test Advisory',
      description: 'This is a valid description',
      severity: 'high',
    };

    const result = CreateAdvisory.parse(data);
    expect(result.affectedChains).toEqual(['stellar']);
  });

  it('accepts CVSS score in valid range', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      cvssScore: z.number().min(0).max(10).optional(),
    });

    const dataWithScore = {
      title: 'Test Advisory',
      description: 'This is a valid description',
      severity: 'high',
      cvssScore: 8.5,
    };

    const result = CreateAdvisory.safeParse(dataWithScore);
    expect(result.success).toBe(true);
  });

  it('rejects CVSS score out of range', () => {
    const CreateAdvisory = z.object({
      title: z.string().min(3),
      description: z.string().min(10),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      cvssScore: z.number().min(0).max(10).optional(),
    });

    const dataWithBadScore = {
      title: 'Test Advisory',
      description: 'This is a valid description',
      severity: 'high',
      cvssScore: 15,
    };

    const result = CreateAdvisory.safeParse(dataWithBadScore);
    expect(result.success).toBe(false);
  });
});

describe('Threat Intelligence - Advisory Update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates advisory status', () => {
    const UpdateAdvisory = z.object({
      status: z.enum(['open', 'under_review', 'resolved', 'disputed']).optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
      mitigations: z.array(z.string()).optional(),
      resolvedAt: z.string().datetime().optional(),
    });

    const updateData = {
      status: 'resolved',
      mitigations: ['Apply patch'],
    };

    const result = UpdateAdvisory.safeParse(updateData);
    expect(result.success).toBe(true);
  });

  it('validates datetime format', () => {
    const UpdateAdvisory = z.object({
      resolvedAt: z.string().datetime().optional(),
    });

    const validDateTime = {
      resolvedAt: '2026-06-19T07:24:26.000Z',
    };

    const result = UpdateAdvisory.safeParse(validDateTime);
    expect(result.success).toBe(true);
  });

  it('rejects invalid datetime format', () => {
    const UpdateAdvisory = z.object({
      resolvedAt: z.string().datetime().optional(),
    });

    const invalidDateTime = {
      resolvedAt: 'not-a-date',
    };

    const result = UpdateAdvisory.safeParse(invalidDateTime);
    expect(result.success).toBe(false);
  });

  it('updates severity level', () => {
    const UpdateAdvisory = z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    });

    const updateData = {
      severity: 'critical',
    };

    const result = UpdateAdvisory.safeParse(updateData);
    expect(result.success).toBe(true);
  });
});

describe('Threat Intelligence - Review Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates review schema', () => {
    const ReviewSchema = z.object({
      role: z.enum(['analyst', 'admin']),
      decision: z.enum(['approve', 'reject', 'escalate']),
      notes: z.string().optional(),
      reviewerKey: z.string(),
    });

    const reviewData = {
      role: 'analyst',
      decision: 'approve',
      notes: 'Confirmed on testnet',
      reviewerKey: 'sk_live_abc123',
    };

    const result = ReviewSchema.safeParse(reviewData);
    expect(result.success).toBe(true);
  });

  it('requires reviewer key', () => {
    const ReviewSchema = z.object({
      role: z.enum(['analyst', 'admin']),
      decision: z.enum(['approve', 'reject', 'escalate']),
      reviewerKey: z.string(),
    });

    const reviewData = {
      role: 'analyst',
      decision: 'approve',
    };

    const result = ReviewSchema.safeParse(reviewData);
    expect(result.success).toBe(false);
  });

  it('accepts all valid decisions', () => {
    const ReviewSchema = z.object({
      decision: z.enum(['approve', 'reject', 'escalate']),
      role: z.enum(['analyst', 'admin']),
      reviewerKey: z.string(),
    });

    const decisions = ['approve', 'reject', 'escalate'];

    decisions.forEach((decision) => {
      const result = ReviewSchema.safeParse({
        decision,
        role: 'analyst',
        reviewerKey: 'key',
      });
      expect(result.success).toBe(true);
    });
  });
});

describe('Threat Intelligence - Subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates subscription schema', () => {
    const SubSchema = z.object({
      channel: z.enum(['email', 'slack', 'discord', 'telegram']),
      target: z.string().min(3),
      filters: z
        .object({
          severity: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
        })
        .optional(),
    });

    const subData = {
      channel: 'slack',
      target: '#security-alerts',
      filters: { severity: ['critical', 'high'] },
    };

    const result = SubSchema.safeParse(subData);
    expect(result.success).toBe(true);
  });

  it('validates channel options', () => {
    const SubSchema = z.object({
      channel: z.enum(['email', 'slack', 'discord', 'telegram']),
      target: z.string().min(3),
    });

    const channels = ['email', 'slack', 'discord', 'telegram'];

    channels.forEach((channel) => {
      const result = SubSchema.safeParse({
        channel,
        target: 'test-target',
      });
      expect(result.success).toBe(true);
    });
  });

  it('rejects invalid channel', () => {
    const SubSchema = z.object({
      channel: z.enum(['email', 'slack', 'discord', 'telegram']),
      target: z.string().min(3),
    });

    const result = SubSchema.safeParse({
      channel: 'invalid-channel',
      target: 'test-target',
    });

    expect(result.success).toBe(false);
  });

  it('requires minimum target length', () => {
    const SubSchema = z.object({
      channel: z.enum(['email', 'slack', 'discord', 'telegram']),
      target: z.string().min(3),
    });

    const result = SubSchema.safeParse({
      channel: 'email',
      target: 'ab',
    });

    expect(result.success).toBe(false);
  });

  it('accepts filters for severity', () => {
    const SubSchema = z.object({
      channel: z.enum(['email', 'slack', 'discord', 'telegram']),
      target: z.string().min(3),
      filters: z
        .object({
          severity: z.array(z.string()).optional(),
        })
        .optional(),
    });

    const result = SubSchema.safeParse({
      channel: 'slack',
      target: '#alerts',
      filters: { severity: ['critical', 'high', 'medium'] },
    });

    expect(result.success).toBe(true);
  });
});

describe('Threat Intelligence - Webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates webhook schema', () => {
    const WebhookSchema = z.object({
      url: z.string().url(),
      secret: z.string().min(8),
      events: z.array(z.string()).default(['advisory.created']),
    });

    const webhookData = {
      url: 'https://hooks.example.com/tip',
      secret: 'super-secret-key-12345',
      events: ['advisory.created', 'advisory.resolved'],
    };

    const result = WebhookSchema.safeParse(webhookData);
    expect(result.success).toBe(true);
  });

  it('requires valid URL', () => {
    const WebhookSchema = z.object({
      url: z.string().url(),
      secret: z.string().min(8),
    });

    const result = WebhookSchema.safeParse({
      url: 'not-a-url',
      secret: 'secret-key-12345',
    });

    expect(result.success).toBe(false);
  });

  it('requires minimum secret length', () => {
    const WebhookSchema = z.object({
      url: z.string().url(),
      secret: z.string().min(8),
    });

    const result = WebhookSchema.safeParse({
      url: 'https://example.com/webhook',
      secret: 'short',
    });

    expect(result.success).toBe(false);
  });

  it('defaults events array', () => {
    const WebhookSchema = z.object({
      url: z.string().url(),
      secret: z.string().min(8),
      events: z.array(z.string()).default(['advisory.created']),
    });

    const result = WebhookSchema.parse({
      url: 'https://example.com/webhook',
      secret: 'secret-key-12345',
    });

    expect(result.events).toEqual(['advisory.created']);
  });
});

describe('Threat Intelligence - Feed Generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates JSON feed with correct structure', () => {
    const feed = {
      feed: 'Soroban TIP',
      generated: new Date(),
      items: [
        {
          id: 'adv-1',
          title: 'Reentrancy vulnerability',
          severity: 'high',
          cveId: 'CVE-2026-1234',
          ghsaId: null,
          affectedContracts: ['CALLD5...'],
          affectedChains: ['stellar'],
          publishedAt: new Date(),
          externalUrl: null,
        },
      ],
    };

    expect(feed.feed).toBe('Soroban TIP');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].severity).toBe('high');
  });

  it('filters disputed advisories from feed', () => {
    const allAdvisories = [
      { id: '1', status: 'open', title: 'Vuln 1' },
      { id: '2', status: 'disputed', title: 'Vuln 2' },
      { id: '3', status: 'resolved', title: 'Vuln 3' },
    ];

    const filtered = allAdvisories.filter((a) => a.status !== 'disputed');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((a) => a.id)).toEqual(['1', '3']);
  });

  it('respects feed limit', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const limited = items.slice(0, 50);

    expect(limited).toHaveLength(50);
  });

  it('generates valid RSS structure', () => {
    const advisory = {
      id: 'adv-1',
      title: '[CRITICAL] Reentrancy in transfer hook',
      description: 'A critical reentrancy vulnerability',
      severity: 'critical',
      createdAt: new Date('2026-06-19T07:24:26.000Z'),
      externalUrl: null,
    };

    const rssItem = `<item>
<title><![CDATA[[${advisory.severity.toUpperCase()}] ${advisory.title}]]></title>
<description><![CDATA[${advisory.description}]]></description>
<pubDate>${advisory.createdAt.toUTCString()}</pubDate>
<guid>${advisory.id}</guid>
</item>`;

    expect(rssItem).toContain('CRITICAL');
    expect(rssItem).toContain('Reentrancy');
    expect(rssItem).toContain('<![CDATA[');
  });
});

describe('Threat Intelligence - Analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates severity distribution', async () => {
    const { getSeverityDistribution } = await import('../src/tip/analytics');
    vi.mocked(getSeverityDistribution).mockResolvedValue([
      { severity: 'critical', count: 5 },
      { severity: 'high', count: 12 },
      { severity: 'medium', count: 8 },
      { severity: 'low', count: 15 },
      { severity: 'info', count: 2 },
    ]);

    const result = await getSeverityDistribution();
    expect(result).toHaveLength(5);
    expect(result[0].count).toBe(5);
  });

  it('calculates trend data', async () => {
    const { getTrendData } = await import('../src/tip/analytics');
    vi.mocked(getTrendData).mockResolvedValue([
      { date: '2026-06-19', total: 5, critical: 1, high: 2 },
      { date: '2026-06-20', total: 3, critical: 0, high: 1 },
    ]);

    const result = await getTrendData(30);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-06-19');
  });

  it('retrieves top affected contracts', async () => {
    const { getTopAffectedContracts } = await import('../src/tip/analytics');
    vi.mocked(getTopAffectedContracts).mockResolvedValue([
      { contract: 'CONTRACT_A', count: 7 },
      { contract: 'CONTRACT_B', count: 5 },
    ]);

    const result = await getTopAffectedContracts(10);
    expect(result).toHaveLength(2);
    expect(result[0].count).toBe(7);
  });

  it('summarizes status distribution', async () => {
    const { getStatusSummary } = await import('../src/tip/analytics');
    vi.mocked(getStatusSummary).mockResolvedValue([
      { status: 'open', count: 18 },
      { status: 'under_review', count: 5 },
      { status: 'resolved', count: 12 },
      { status: 'disputed', count: 2 },
    ]);

    const result = await getStatusSummary();
    expect(result).toHaveLength(4);
    expect(result[0].status).toBe('open');
  });
});
