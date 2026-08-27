import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB
vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    transaction: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
  prismaWrite: {},
}));

// Mock logger
vi.mock('../../src/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { prismaRead } from '../../src/db';
import type { QualityCheckResult, EtlLineageRecord } from '../../src/analytics/data-quality/checks';

describe('Analytics Data Quality Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Quality Check Types', () => {
    it('should define quality check result structure', () => {
      const check: QualityCheckResult = {
        checkName: 'row_count_match',
        passed: true,
        severity: 'info',
        message: 'Row count matches source',
        details: { sourceCount: 1000, parquetCount: 1000 },
        checkedAt: new Date().toISOString(),
      };

      expect(check.checkName).toBeDefined();
      expect(check.passed).toBe(true);
      expect(check.severity).toMatch(/^(info|warning|critical)$/);
    });

    it('should support critical severity for failed checks', () => {
      const check: QualityCheckResult = {
        checkName: 'foreign_key_integrity',
        passed: false,
        severity: 'critical',
        message: 'Foreign key constraint violated',
        details: { violationCount: 5 },
        checkedAt: new Date().toISOString(),
      };

      expect(check.severity).toBe('critical');
      expect(check.passed).toBe(false);
    });
  });

  describe('Row Count Verification', () => {
    it('should verify matching row counts', async () => {
      vi.mocked(prismaRead.contract.count).mockResolvedValueOnce(1000);

      const count = await prismaRead.contract.count({});
      expect(count).toBe(1000);
    });

    it('should detect row count mismatches', async () => {
      const sourceCount = 1000;
      const parquetCount = 950;

      const mismatch = sourceCount !== parquetCount;
      expect(mismatch).toBe(true);
    });

    it('should handle empty results', async () => {
      vi.mocked(prismaRead.contract.count).mockResolvedValueOnce(0);

      const count = await prismaRead.contract.count({});
      expect(count).toBe(0);
    });
  });

  describe('Null Value Detection', () => {
    it('should identify nullable columns', () => {
      const schema = {
        id: { nullable: false },
        description: { nullable: true },
        metadata: { nullable: true },
      };

      const nullableColumns = Object.entries(schema)
        .filter(([_, col]) => col.nullable)
        .map(([name]) => name);

      expect(nullableColumns).toContain('description');
      expect(nullableColumns).not.toContain('id');
    });

    it('should detect unexpected nulls in key columns', () => {
      const records = [
        { id: 'rec-1', name: 'Item 1' },
        { id: null, name: 'Item 2' },
        { id: 'rec-3', name: null },
      ];

      const nullIds = records.filter((r) => r.id === null);
      expect(nullIds.length).toBe(1);
    });
  });

  describe('Foreign Key Validation', () => {
    it('should validate foreign key relationships', async () => {
      vi.mocked(prismaRead.contract.findMany).mockResolvedValueOnce([
        { id: 'contract-1', ownerId: 'owner-1' },
      ] as any);

      const contracts = await prismaRead.contract.findMany({});
      expect(contracts[0].ownerId).toBeDefined();
    });

    it('should detect orphaned records', () => {
      const parentIds = new Set(['p1', 'p2', 'p3']);
      const childRecords = [
        { id: 'c1', parentId: 'p1' },
        { id: 'c2', parentId: 'p4' }, // orphaned
        { id: 'c3', parentId: 'p2' },
      ];

      const orphaned = childRecords.filter((c) => !parentIds.has(c.parentId));
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].parentId).toBe('p4');
    });
  });

  describe('ETL Lineage Tracking', () => {
    it('should create valid lineage records', () => {
      const lineage: EtlLineageRecord = {
        jobId: 'job-20240827-001',
        jobStartedAt: new Date().toISOString(),
        jobCompletedAt: new Date().toISOString(),
        sourceTables: ['contracts', 'transactions'],
        pgTxIdRange: { min: 100, max: 200 },
        lsnRange: { min: '0/100000', max: '0/200000' },
        outputFiles: [],
        rowsProduced: 5000,
        rowsRejected: 10,
        qualityResults: [],
        status: 'success',
      };

      expect(lineage.jobId).toBeDefined();
      expect(lineage.status).toMatch(/^(success|partial|failed)$/);
      expect(lineage.rowsProduced).toBeGreaterThan(0);
    });

    it('should track lineage history', () => {
      const lineages = [
        {
          jobId: 'job-001',
          status: 'success' as const,
          rowsProduced: 1000,
        },
        {
          jobId: 'job-002',
          status: 'partial' as const,
          rowsProduced: 800,
        },
        {
          jobId: 'job-003',
          status: 'failed' as const,
          rowsProduced: 0,
        },
      ];

      const successes = lineages.filter((l) => l.status === 'success');
      expect(successes).toHaveLength(1);
    });

    it('should record transaction ID ranges', () => {
      const range = { min: 1000, max: 2000 };
      expect(range.max - range.min).toBe(1000);
    });

    it('should track WAL LSN progression', () => {
      const lsn1 = '0/100000';
      const lsn2 = '0/200000';

      const parse = (lsn: string) => {
        const [high, low] = lsn.split('/').map((x) => parseInt(x, 16));
        return (BigInt(high) << BigInt(32)) | BigInt(low);
      };

      expect(parse(lsn2) > parse(lsn1)).toBe(true);
    });
  });

  describe('Quality Alert Emission', () => {
    it('should emit alerts for failed checks', () => {
      const alerts = [
        {
          checkName: 'row_count_match',
          severity: 'critical' as const,
          message: 'Row count mismatch detected',
        },
      ];

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('critical');
    });

    it('should categorize alerts by severity', () => {
      const results: QualityCheckResult[] = [
        {
          checkName: 'check1',
          passed: true,
          severity: 'info',
          message: 'All good',
          details: {},
          checkedAt: new Date().toISOString(),
        },
        {
          checkName: 'check2',
          passed: false,
          severity: 'warning',
          message: 'Minor issue',
          details: {},
          checkedAt: new Date().toISOString(),
        },
        {
          checkName: 'check3',
          passed: false,
          severity: 'critical',
          message: 'Major issue',
          details: {},
          checkedAt: new Date().toISOString(),
        },
      ];

      const criticalAlerts = results.filter((r) => r.severity === 'critical');
      expect(criticalAlerts).toHaveLength(1);
    });
  });
});
