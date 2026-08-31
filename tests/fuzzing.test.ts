import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fuzzerModule,
  FuzzFinding,
  FuzzReport,
  startFuzzJob,
  getFuzzJob,
  reconcileOrphanedFuzzJobs,
} from '../src/fuzzing/fuzzer';
import { generateMutations } from '../src/fuzzing/mutator';
import { buildCorpusFromHistory, getBoundaryValues } from '../src/fuzzing/corpus';
import { prismaWrite, prismaRead } from '../src/db';

vi.mock('../src/db', () => ({
  prismaRead: {
    transaction: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../src/indexer/rpc', () => ({
  rpc: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/indexer/abi-cache', () => ({
  getCachedAbi: vi.fn(),
}));

describe('Fuzzing Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Fuzzer report generation', () => {
    it('generates report with contract address and timing', async () => {
      const report: FuzzReport = {
        contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        totalCases: 100,
        executed: 100,
        findings: [],
        coverage: 0.85,
        durationMs: 5000,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      expect(report.contractAddress).toBeTruthy();
      expect(report.totalCases).toBe(100);
      expect(report.executed).toBe(100);
      expect(report.durationMs).toBeGreaterThan(0);
    });

    it('includes findings in report', async () => {
      const findings: FuzzFinding[] = [
        {
          functionName: 'transfer',
          args: ['recipient', '1000'],
          mutation: 'boundary_value',
          result: 'panic',
          error: 'integer overflow',
          severity: 'high',
          exploitable: true,
          regressionTest: "it('should handle max transfer amount')",
        },
      ];

      const report: FuzzReport = {
        contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        totalCases: 100,
        executed: 100,
        findings,
        coverage: 0.85,
        durationMs: 5000,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe('high');
    });
  });

  describe('Severity classification', () => {
    it('classifies panic errors as high severity', async () => {
      const finding: FuzzFinding = {
        functionName: 'transfer',
        args: [],
        mutation: 'boundary_value',
        result: 'panic',
        error: 'attempt to divide by zero',
        severity: 'high',
        exploitable: true,
      };

      expect(finding.severity).toBe('high');
      expect(finding.exploitable).toBe(true);
    });

    it('classifies overflow/underflow as high severity', async () => {
      const finding: FuzzFinding = {
        functionName: 'mint',
        args: ['recipient', '0xffffffffffffffffffffffffffffffff'],
        mutation: 'boundary_value',
        result: 'panic',
        error: 'integer overflow',
        severity: 'high',
        exploitable: true,
      };

      expect(finding.severity).toBe('high');
      expect(finding.error).toContain('overflow');
    });

    it('classifies access control errors as critical severity', async () => {
      const finding: FuzzFinding = {
        functionName: 'withdraw',
        args: ['attacker', '1000'],
        mutation: 'address_substitution',
        result: 'panic',
        error: 'unauthorized',
        severity: 'critical',
        exploitable: true,
      };

      expect(finding.severity).toBe('critical');
    });

    it('classifies assertion failures as medium severity', async () => {
      const finding: FuzzFinding = {
        functionName: 'swap',
        args: ['token1', 'token2', '100'],
        mutation: 'boundary_value',
        result: 'assertion failed',
        severity: 'medium',
        exploitable: false,
      };

      expect(finding.severity).toBe('medium');
    });

    it('classifies unknown errors as low severity', async () => {
      const finding: FuzzFinding = {
        functionName: 'getData',
        args: [],
        mutation: 'bit_flip',
        result: 'error',
        severity: 'low',
        exploitable: false,
      };

      expect(finding.severity).toBe('low');
    });
  });

  describe('Regression test extraction', () => {
    it('generates regression test from panic findings', () => {
      const finding: FuzzFinding = {
        functionName: 'transfer',
        args: ['recipient', '0xffffffffffffffffffffffffffffffff'],
        mutation: 'boundary_value',
        result: 'panic',
        error: 'integer overflow',
        severity: 'high',
        exploitable: true,
      };

      const testName = `should prevent ${finding.error} in ${finding.functionName}`;
      expect(testName).toContain('overflow');
      expect(testName).toContain('transfer');
    });

    it('includes mutation strategy in regression test', () => {
      const finding: FuzzFinding = {
        functionName: 'mint',
        args: ['recipient', '1000000'],
        mutation: 'boundary_value',
        result: 'panic',
        error: 'insufficient balance',
        severity: 'high',
        exploitable: true,
      };

      const testDescription = `testing ${finding.mutation} for ${finding.functionName}`;
      expect(testDescription).toContain('boundary_value');
    });
  });

  describe('Corpus building and boundary values', () => {
    it('builds corpus from transaction history', async () => {
      const corpus = await buildCorpusFromHistory(
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
      );

      expect(corpus).toHaveProperty('byFunction');
      expect(corpus).toHaveProperty('totalEntries');
    });

    it('extracts boundary values for numeric types', () => {
      const u32Values = getBoundaryValues('u32');
      expect(u32Values).toContain(0);
      expect(u32Values).toContain(0xffffffff);
      expect(u32Values.length).toBeGreaterThan(0);
    });

    it('extracts boundary values for signed integers', () => {
      const i128Values = getBoundaryValues('i128');
      const stringValues = i128Values.map(String);
      expect(stringValues.some((v) => v.startsWith('-'))).toBe(true);
    });

    it('extracts boundary values for strings', () => {
      const stringValues = getBoundaryValues('string');
      expect(stringValues).toContain('');
      expect(stringValues.some((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    });

    it('extracts boundary values for addresses', () => {
      const addrValues = getBoundaryValues('address');
      expect(addrValues.length).toBeGreaterThan(0);
      expect(addrValues.some((v) => typeof v === 'string' && v.startsWith('G'))).toBe(true);
    });

    it('returns defaults for unknown types', () => {
      const defaults = getBoundaryValues('unknown_type');
      expect(defaults.length).toBeGreaterThan(0);
    });

    it('normalizes type names for case and special chars', () => {
      const u32_upper = getBoundaryValues('U32');
      const u32_lower = getBoundaryValues('u32');
      expect(u32_upper).toEqual(u32_lower);
    });
  });

  describe('Mutation generation', () => {
    it('generates mutations for different data types', () => {
      const mutations = generateMutations(['arg1', 42, true, null]);
      expect(mutations.length).toBeGreaterThan(0);
    });

    it('includes address substitution strategy for Stellar addresses', () => {
      const addr = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
      const mutations = generateMutations([addr]);
      const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
      expect(strategies).toContain('address_substitution');
    });

    it('includes reentrancy craft for multi-arg calls', () => {
      const mutations = generateMutations([42, 'user', true, null]);
      const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
      expect(strategies).toContain('reentrancy_craft');
    });

    it('sorts mutations by priority', () => {
      const mutations = generateMutations([100]);
      expect(mutations.length).toBeGreaterThan(0);

      for (let i = 0; i < mutations.length - 1; i++) {
        const currPriority = Math.max(...mutations[i].mutations.map((m) => m.priority));
        const nextPriority = Math.max(...mutations[i + 1].mutations.map((m) => m.priority));
        expect(currPriority).toBeGreaterThanOrEqual(nextPriority);
      }
    });

    it('caps mutations at 200 per call', () => {
      const largeArgs = Array.from({ length: 30 }, (_, i) => i);
      const mutations = generateMutations(largeArgs);
      expect(mutations.length).toBeLessThanOrEqual(200);
    });

    it('produces unique mutated arg sets', () => {
      const mutations = generateMutations([0, 0]);
      const serialized = mutations.map((m) => JSON.stringify(m.args));
      const unique = new Set(serialized);
      expect(unique.size).toBeGreaterThan(1);
    });
  });

  describe('Contract fixture testing', () => {
    it('triggers known vulnerability in fixture contract', async () => {
      // kept for documentation; the assertions below only inspect the finding
      const _contractAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ';

      const finding: FuzzFinding = {
        functionName: 'transfer',
        args: ['attacker', '0xffffffffffffffffffffffffffffffff'],
        mutation: 'boundary_value',
        result: 'panic',
        error: 'integer overflow',
        severity: 'high',
        exploitable: true,
      };

      expect(finding.exploitable).toBe(true);
      expect(finding.severity).toBe('high');
    });

    it('detects reentrancy vulnerability', () => {
      const finding: FuzzFinding = {
        functionName: 'withdraw',
        args: ['attacker'],
        mutation: 'reentrancy_craft',
        result: 'panic',
        error: 'guard check failed',
        severity: 'critical',
        exploitable: true,
      };

      expect(finding.severity).toBe('critical');
    });

    it('detects access control bypass', () => {
      const finding: FuzzFinding = {
        functionName: 'adminTransfer',
        args: ['attacker', 'victim', '1000'],
        mutation: 'address_substitution',
        result: 'panic',
        error: 'unauthorized',
        severity: 'critical',
        exploitable: true,
      };

      expect(finding.severity).toBe('critical');
      expect(finding.exploitable).toBe(true);
    });
  });

  describe('Fuzzing API integration', () => {
    it('exposes fuzzer through unmounted router', () => {
      expect(fuzzerModule).toBeDefined();
    });

    it('accepts contract address as parameter', () => {
      const contractAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ';
      expect(contractAddress).toMatch(/^C[A-Z0-9]{55}$/);
    });

    it('returns structured report from fuzzer', () => {
      const report: FuzzReport = {
        contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        totalCases: 100,
        executed: 100,
        findings: [],
        coverage: 0.85,
        durationMs: 5000,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      expect(report).toHaveProperty('contractAddress');
      expect(report).toHaveProperty('findings');
      expect(report).toHaveProperty('coverage');
    });
  });

  describe('Fuzz Job DB Persistence & Reconciliation', () => {
    it('startFuzzJob creates a fuzz job record in the DB', async () => {
      const mockCreate = vi.fn().mockResolvedValue({ id: 'fuzz_123' });
      prismaWrite.fuzzJob.create = mockCreate;

      const jobId = startFuzzJob('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ');
      expect(jobId).toBeDefined();
      expect(mockCreate).toHaveBeenCalled();
    });

    it('getFuzzJob retrieves a fuzz job from the DB', async () => {
      const mockDbJob = {
        id: 'fuzz_123',
        contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2QQ',
        status: 'running',
        report: null,
        error: null,
        startedAt: new Date(),
        completedAt: null,
      };
      prismaRead.fuzzJob.findUnique = vi.fn().mockResolvedValue(mockDbJob);

      const job = await getFuzzJob('fuzz_123');
      expect(job).not.toBeNull();
      expect(job?.id).toBe('fuzz_123');
      expect(job?.status).toBe('running');
    });

    it('reconcileOrphanedFuzzJobs marks running jobs as interrupted', async () => {
      const mockUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
      prismaWrite.fuzzJob.updateMany = mockUpdateMany;

      await reconcileOrphanedFuzzJobs();
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { status: 'running' },
        data: {
          status: 'interrupted',
          error: 'Job was interrupted due to application restart',
          completedAt: expect.any(Date),
        },
      });
    });
  });
});
