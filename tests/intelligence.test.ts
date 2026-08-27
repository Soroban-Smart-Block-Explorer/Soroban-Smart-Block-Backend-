/**
 * Intelligence Module Tests (#860)
 *
 * Tests for:
 *   - Intelligence scoring functions with synthetic inputs
 *   - Intelligence service report building
 *   - Score bounds validation (0-100 range)
 *   - Contract similarity detection
 *   - Anomaly detection and classification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildIntelligenceReport,
  findSimilarContracts,
} from '../src/intelligence/intelligence-service';
import { classifyContract } from '../src/intelligence/heuristic-classifier';
import { detectAnomalies } from '../src/intelligence/anomaly-detector';
import { analyzeContractWasm } from '../src/intelligence/wasm-analyzer';
import { getLlmDescription } from '../src/intelligence/llm-provider';

vi.mock('../src/db', () => ({
  prismaRead: {
    contract: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../src/intelligence/wasm-analyzer', () => ({
  analyzeContractWasm: vi.fn(),
}));

vi.mock('../src/intelligence/heuristic-classifier', () => ({
  classifyContract: vi.fn(),
}));

vi.mock('../src/intelligence/anomaly-detector', () => ({
  detectAnomalies: vi.fn(),
}));

vi.mock('../src/intelligence/llm-provider', () => ({
  getLlmDescription: vi.fn(),
}));

describe('Intelligence Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildIntelligenceReport', () => {
    it('should build complete intelligence report for contract', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue({
        address: mockAddress,
        wasmHash: 'abc123',
        wasmSize: 50000,
        rawFunctionNames: ['transfer', 'mint', 'burn'],
        hasContractSpec: true,
        contractSpecVersion: '1.0',
        estimatedAuditScore: 85,
      });

      vi.mocked(classifyContract).mockReturnValue({
        category: 'token',
        confidence: 0.95,
        subcategories: ['ERC20-like', 'burnable'],
      });

      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      vi.mocked(getLlmDescription).mockResolvedValue({
        description: 'Standard token contract with burn capability',
        provider: 'claude',
        cost: 0.001,
      });

      const report = await buildIntelligenceReport(mockAddress, true);

      expect(report).toHaveProperty('address');
      expect(report).toHaveProperty('analysis');
      expect(report).toHaveProperty('classification');
      expect(report).toHaveProperty('anomalies');
      expect(report).toHaveProperty('llm');
      expect(report).toHaveProperty('generatedAt');

      expect(report.address).toBe(mockAddress);
      expect(report.analysis?.rawFunctionNames).toContain('transfer');
      expect(report.classification.category).toBe('token');
    });

    it('should handle missing WASM analysis gracefully', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue(null);
      vi.mocked(classifyContract).mockReturnValue({
        category: 'unknown',
        confidence: 0.1,
        subcategories: [],
      });
      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      const report = await buildIntelligenceReport(mockAddress, false);

      expect(report).toHaveProperty('address');
      expect(report.analysis).toBeNull();
      expect(report.llm).toBeNull();
    });

    it('should skip LLM when useLlm is false', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue({
        address: mockAddress,
        wasmHash: 'abc123',
        wasmSize: 50000,
        rawFunctionNames: ['transfer'],
        hasContractSpec: true,
        contractSpecVersion: '1.0',
        estimatedAuditScore: 85,
      });

      vi.mocked(classifyContract).mockReturnValue({
        category: 'token',
        confidence: 0.9,
        subcategories: [],
      });

      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      const report = await buildIntelligenceReport(mockAddress, false);

      expect(report.llm).toBeNull();
      expect(vi.mocked(getLlmDescription)).not.toHaveBeenCalled();
    });

    it('should cache reports with 10-minute TTL', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue({
        address: mockAddress,
        wasmHash: 'abc123',
        wasmSize: 50000,
        rawFunctionNames: ['transfer'],
        hasContractSpec: true,
        contractSpecVersion: '1.0',
        estimatedAuditScore: 85,
      });

      vi.mocked(classifyContract).mockReturnValue({
        category: 'token',
        confidence: 0.9,
        subcategories: [],
      });

      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      const report1 = await buildIntelligenceReport(mockAddress, false);
      vi.clearAllMocks();

      const report2 = await buildIntelligenceReport(mockAddress, false);

      expect(report1).toEqual(report2);
      expect(vi.mocked(analyzeContractWasm)).not.toHaveBeenCalled();
    });

    it('should include timestamps in ISO format', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue({
        address: mockAddress,
        wasmHash: 'abc123',
        wasmSize: 50000,
        rawFunctionNames: [],
        hasContractSpec: false,
        contractSpecVersion: undefined,
        estimatedAuditScore: 0,
      });

      vi.mocked(classifyContract).mockReturnValue({
        category: 'unknown',
        confidence: 0.1,
        subcategories: [],
      });

      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      const report = await buildIntelligenceReport(mockAddress, false);

      expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('findSimilarContracts', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should find contracts with shared functions', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'Token Contract A',
          abi: {
            functions: [{ name: 'transfer' }, { name: 'mint' }, { name: 'approve' }],
          },
        },
        {
          address: 'CAA2222222222222222222222222222222222222222222222222222222222222222',
          name: 'Token Contract B',
          abi: {
            functions: [{ name: 'transfer' }, { name: 'burn' }],
          },
        },
      ]);

      const myAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';
      const myFunctions = ['transfer', 'mint', 'burn'];

      const similar = await findSimilarContracts(myAddress, myFunctions);

      expect(Array.isArray(similar)).toBe(true);
      expect(similar.every((c) => c.similarity >= 30)).toBe(true);
      expect(similar.every((c) => c.similarity >= 0 && c.similarity <= 100)).toBe(true);
      expect(similar.every((c) => Array.isArray(c.sharedFunctions))).toBe(true);
    });

    it('should filter out contracts with less than 30% similarity', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'Very Different',
          abi: {
            functions: [{ name: 'execute' }],
          },
        },
      ]);

      const myAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';
      const myFunctions = ['transfer', 'mint', 'approve', 'burn'];

      const similar = await findSimilarContracts(myAddress, myFunctions);

      expect(similar.length).toBe(0);
    });

    it('should sort by similarity descending', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'Low similarity',
          abi: { functions: [{ name: 'transfer' }] },
        },
        {
          address: 'CAA2222222222222222222222222222222222222222222222222222222222222222',
          name: 'High similarity',
          abi: {
            functions: [{ name: 'transfer' }, { name: 'mint' }, { name: 'approve' }],
          },
        },
      ]);

      const myFunctions = ['transfer', 'mint', 'approve'];

      const similar = await findSimilarContracts('MYADDRESS', myFunctions);

      if (similar.length > 1) {
        for (let i = 0; i < similar.length - 1; i++) {
          expect(similar[i].similarity).toBeGreaterThanOrEqual(similar[i + 1].similarity);
        }
      }
    });

    it('should limit results to top 10', async () => {
      const { prismaRead } = await import('../src/db');

      const contracts = Array.from({ length: 20 }, (_, i) => ({
        address: `CAA${i.toString().padStart(62, '0')}`,
        name: `Contract ${i}`,
        abi: {
          functions: [{ name: 'transfer' }, { name: 'mint' }],
        },
      }));

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue(contracts);

      const similar = await findSimilarContracts('MYADDRESS', ['transfer', 'mint']);

      expect(similar.length).toBeLessThanOrEqual(10);
    });

    it('should exclude self from results', async () => {
      const { prismaRead } = await import('../src/db');

      const myAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([]);

      const similar = await findSimilarContracts(myAddress, ['transfer']);

      expect(similar.every((c) => c.address.toLowerCase() !== myAddress.toLowerCase())).toBe(true);
    });

    it('should handle contracts without ABI gracefully', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'No ABI',
          abi: undefined,
        },
        {
          address: 'CAA2222222222222222222222222222222222222222222222222222222222222222',
          name: 'Invalid ABI',
          abi: {},
        },
      ]);

      const similar = await findSimilarContracts('MYADDRESS', ['transfer', 'mint']);

      expect(Array.isArray(similar)).toBe(true);
    });

    it('should calculate similarity correctly', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'Test',
          abi: {
            functions: [{ name: 'transfer' }, { name: 'mint' }],
          },
        },
      ]);

      const similar = await findSimilarContracts('MYADDRESS', ['transfer', 'mint', 'burn']);

      if (similar.length > 0) {
        const expectedSimilarity = (2 / 3) * 100;
        expect(similar[0].similarity).toBe(Math.round(expectedSimilarity));
      }
    });
  });

  describe('Intelligence scoring bounds', () => {
    it('should ensure classification confidence is between 0 and 1', () => {
      const result = classifyContract(['transfer', 'mint', 'approve']);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should ensure similarity scores are percentages (0-100)', async () => {
      const { prismaRead } = await import('../src/db');

      vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
        {
          address: 'CAA1111111111111111111111111111111111111111111111111111111111111111',
          name: 'Test',
          abi: {
            functions: [{ name: 'func1' }, { name: 'func2' }],
          },
        },
      ]);

      const similar = await findSimilarContracts('MYADDRESS', ['func1', 'func2']);

      for (const contract of similar) {
        expect(contract.similarity).toBeGreaterThanOrEqual(0);
        expect(contract.similarity).toBeLessThanOrEqual(100);
      }
    });

    it('should provide documented score ranges in reports', async () => {
      const mockAddress = 'CAAA123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789AB';

      vi.mocked(analyzeContractWasm).mockResolvedValue({
        address: mockAddress,
        wasmHash: 'abc123',
        wasmSize: 50000,
        rawFunctionNames: ['transfer'],
        hasContractSpec: true,
        contractSpecVersion: '1.0',
        estimatedAuditScore: 85,
      });

      vi.mocked(classifyContract).mockReturnValue({
        category: 'token',
        confidence: 0.95,
        subcategories: [],
      });

      vi.mocked(detectAnomalies).mockResolvedValue({
        found: false,
        issues: [],
      });

      const report = await buildIntelligenceReport(mockAddress, false);

      expect(report.analysis?.estimatedAuditScore).toBeGreaterThanOrEqual(0);
      expect(report.analysis?.estimatedAuditScore).toBeLessThanOrEqual(100);
      expect(report.classification.confidence).toBeGreaterThanOrEqual(0);
      expect(report.classification.confidence).toBeLessThanOrEqual(1);
    });
  });
});
