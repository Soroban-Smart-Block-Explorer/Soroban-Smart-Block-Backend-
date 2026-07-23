import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/compliance', () => ({
  screenAddress: vi.fn(),
  batchScreen: vi.fn(),
  getScreeningStatus: vi.fn(),
  getAlerts: vi.fn(),
  reviewAlert: vi.fn(),
  getScreeningSummary: vi.fn(),
  getStats: vi.fn(),
  assessAddressRisk: vi.fn(),
  batchRiskAssessment: vi.fn(),
  refreshAllLists: vi.fn(),
  getListVersions: vi.fn(),
  importCustomList: vi.fn(),
  deleteCustomList: vi.fn(),
  getChangelog: vi.fn(),
  getTravelRule: vi.fn(),
  getPendingTravelRules: vi.fn(),
  submitTravelRule: vi.fn(),
  getTravelRuleSummary: vi.fn(),
  registerWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  unregisterWebhook: vi.fn(),
  generateDailyReport: vi.fn(),
  generateWeeklyReport: vi.fn(),
  generateMonthlyReport: vi.fn(),
  generateAddressReport: vi.fn(),
  listReports: vi.fn(),
  getReport: vi.fn(),
  checkPep: vi.fn(),
  checkAdverseMedia: vi.fn(),
  getCluster: vi.fn(),
  getHighRiskClusters: vi.fn(),
  createBlockingRule: vi.fn(),
  listBlockingRules: vi.fn(),
  updateBlockingRule: vi.fn(),
  deleteBlockingRule: vi.fn(),
  getBlockingActions: vi.fn(),
  generateSarReport: vi.fn(),
  generateRegulatoryReport: vi.fn(),
  detectAnomalies: vi.fn(),
  listAnomalies: vi.fn(),
  reviewAnomaly: vi.fn(),
  getAuditLogs: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    sanctionsList: {
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import * as complianceService from '../../src/services/compliance';
import { complianceRouter } from '../../src/api/compliance';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/compliance', complianceRouter);
  return app;
}

describe('GET /compliance', () => {
  it('returns service overview with endpoints list', async () => {
    const res = await request(makeApp()).get('/compliance');
    expect(res.status).toBe(200);
    expect(res.body.service).toContain('Compliance');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
  });
});

describe('GET /compliance/screen/:address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns screening result', async () => {
    vi.mocked(complianceService.screenAddress).mockResolvedValue({
      address: 'GA_TEST',
      isMatch: false,
      riskScore: 0,
    } as any);

    const res = await request(makeApp()).get('/compliance/screen/GA_TEST');
    expect(res.status).toBe(200);
    expect(complianceService.screenAddress).toHaveBeenCalledWith('GA_TEST', expect.any(Object));
  });
});

describe('POST /compliance/screen/batch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns batch screening results', async () => {
    vi.mocked(complianceService.batchScreen).mockResolvedValue({ results: [] } as any);

    const res = await request(makeApp())
      .post('/compliance/screen/batch')
      .send({ addresses: ['GA_ADDR_1234567890', 'GA_ADDR_0987654321'] });

    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid addresses', async () => {
    const res = await request(makeApp()).post('/compliance/screen/batch').send({ addresses: [] });

    expect(res.status).toBe(400);
  });
});

describe('GET /compliance/alerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns alerts list', async () => {
    vi.mocked(complianceService.getAlerts).mockResolvedValue({ alerts: [], total: 0 } as any);

    const res = await request(makeApp()).get('/compliance/alerts');
    expect(res.status).toBe(200);
  });
});

describe('PUT /compliance/alerts/:id/review', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reviews an alert', async () => {
    vi.mocked(complianceService.reviewAlert).mockResolvedValue({ id: 'alert-1' } as any);

    const res = await request(makeApp())
      .put('/compliance/alerts/alert-1/review')
      .send({ action: 'false_positive', reviewerId: 'user-1' });

    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid action', async () => {
    const res = await request(makeApp())
      .put('/compliance/alerts/alert-1/review')
      .send({ action: 'invalid_action' });

    expect(res.status).toBe(400);
  });
});

describe('GET /compliance/risk/:address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns risk assessment', async () => {
    vi.mocked(complianceService.assessAddressRisk).mockResolvedValue({
      riskScore: 25,
      level: 'low',
    } as any);

    const res = await request(makeApp()).get('/compliance/risk/GA_ADDR');
    expect(res.status).toBe(200);
  });
});

describe('GET /compliance/webhooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns webhooks list', async () => {
    vi.mocked(complianceService.listWebhooks).mockReturnValue([]);

    const res = await request(makeApp()).get('/compliance/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.webhooks).toEqual([]);
  });
});

describe('DELETE /compliance/webhooks/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when webhook not found', async () => {
    vi.mocked(complianceService.unregisterWebhook).mockReturnValue(false);

    const res = await request(makeApp()).delete('/compliance/webhooks/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 204 when webhook deleted', async () => {
    vi.mocked(complianceService.unregisterWebhook).mockReturnValue(true);

    const res = await request(makeApp()).delete('/compliance/webhooks/wh-1');
    expect(res.status).toBe(204);
  });
});

describe('GET /compliance/pep/:address', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns PEP check result', async () => {
    vi.mocked(complianceService.checkPep).mockResolvedValue({ isPep: false } as any);

    const res = await request(makeApp()).get('/compliance/pep/GA_ADDR');
    expect(res.status).toBe(200);
  });
});

describe('GET /compliance/blocking/rules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns blocking rules', async () => {
    vi.mocked(complianceService.listBlockingRules).mockReturnValue([]);

    const res = await request(makeApp()).get('/compliance/blocking/rules');
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual([]);
  });
});

describe('DELETE /compliance/blocking/rules/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when rule not found', async () => {
    vi.mocked(complianceService.deleteBlockingRule).mockReturnValue(false);

    const res = await request(makeApp()).delete('/compliance/blocking/rules/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 204 when rule deleted', async () => {
    vi.mocked(complianceService.deleteBlockingRule).mockReturnValue(true);

    const res = await request(makeApp()).delete('/compliance/blocking/rules/rule-1');
    expect(res.status).toBe(204);
  });
});
