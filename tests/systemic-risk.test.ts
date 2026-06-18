import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  prismaRead: {
    contract: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    portfolioSnapshot: { findMany: vi.fn() },
    oracleCallback: { findMany: vi.fn() },
    sacMapping: { findMany: vi.fn() },
    ammPool: { findMany: vi.fn() },
    governanceContract: { findMany: vi.fn() },
    volumeAlert: { findMany: vi.fn() },
    governanceProposal: { findMany: vi.fn() },
  },
}));

import { prismaRead } from '../src/db';
import {
  buildSystemDependencyGraph,
  computeSystemicImportance,
  computeSystemicFragility,
  simulateCascade,
  computeSystemicRiskIndex,
  computeConcentrationMetrics,
  getProtocolRiskProfile,
  computeCorrelationRisk,
} from '../src/indexer/systemicRisk';

const contractA = 'C' + 'A'.repeat(55);
const contractB = 'C' + 'B'.repeat(55);
const contractC = 'C' + 'C'.repeat(55);
const oracleAddr = 'C' + 'O'.repeat(55);
const bridgeAddr = 'B:issuer123';
const govAddr = 'C' + 'G'.repeat(55);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildSystemDependencyGraph', () => {
  it('builds a graph from contract and transaction data', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'Swap', wasmHash: null, isToken: false },
      { address: contractB, name: 'Lend', wasmHash: 'hash1', isToken: false },
      { address: contractC, name: 'TokenX', wasmHash: null, isToken: true },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      { contractAddress: contractA, functionArgs: { target: contractB } },
    ]);
    vi.mocked(prismaRead.portfolioSnapshot.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.oracleCallback.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.ammPool.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.governanceContract.findMany).mockResolvedValue([]);

    const graph = await buildSystemDependencyGraph();

    expect(graph.metadata.totalProtocols).toBeGreaterThanOrEqual(3);
    expect(graph.metadata.totalEdges).toBeGreaterThanOrEqual(0);
    expect(graph.protocols.has(contractA)).toBe(true);
    expect(graph.protocols.has(contractB)).toBe(true);
    expect(graph.protocols.has(contractC)).toBe(true);
  });

  it('captures oracle dependencies', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'Swap', wasmHash: null, isToken: false },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.portfolioSnapshot.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.oracleCallback.findMany).mockResolvedValue([
      { oracleContractAddress: oracleAddr, dataRequestorAddress: contractA },
    ]);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.ammPool.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.governanceContract.findMany).mockResolvedValue([]);

    const graph = await buildSystemDependencyGraph();

    expect(graph.protocols.has(oracleAddr)).toBe(true);
    expect(graph.edges.some((e) => e.from === contractA && e.to === oracleAddr && e.type === 'oracle')).toBe(true);
  });

  it('captures liquidity dependencies from AMM pools', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'Pool', wasmHash: null, isToken: false },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.portfolioSnapshot.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.oracleCallback.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.ammPool.findMany).mockResolvedValue([
      { poolAddress: contractA, assetAAddress: contractB, assetBAddress: contractC },
    ]);
    vi.mocked(prismaRead.governanceContract.findMany).mockResolvedValue([]);

    const graph = await buildSystemDependencyGraph();

    expect(graph.edges.some((e) => e.from === contractA && e.to === contractB && e.type === 'liquidity')).toBe(true);
    expect(graph.edges.some((e) => e.from === contractA && e.to === contractC && e.type === 'liquidity')).toBe(true);
  });

  it('captures code dependencies from same wasmHash', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'V1', wasmHash: 'abc123', isToken: false },
      { address: contractB, name: 'V2', wasmHash: 'abc123', isToken: false },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.portfolioSnapshot.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.oracleCallback.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.ammPool.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.governanceContract.findMany).mockResolvedValue([]);

    const graph = await buildSystemDependencyGraph();

    expect(graph.edges.some((e) => e.type === 'code')).toBe(true);
    expect(graph.edges.filter((e) => e.type === 'code').length).toBe(1);
  });
});

describe('computeSystemicImportance', () => {
  it('computes importance based on weighted out-degree', () => {
    const graph = makeMockGraph(3, [
      { from: contractA, to: contractB, type: 'call', criticality: 'high', weight: 0.7 },
      { from: contractA, to: contractC, type: 'oracle', criticality: 'critical', weight: 1.0 },
    ]);
    const results = computeSystemicImportance(graph);
    const bImp = results.find((r) => r.address === contractB);
    const cImp = results.find((r) => r.address === contractC);

    // B has 1 dependent (A), C has 1 dependent (A)
    expect(bImp).toBeDefined();
    expect(cImp).toBeDefined();
    expect(bImp!.dependents).toBe(1);
    expect(cImp!.dependents).toBe(1);
  });
});

describe('computeSystemicFragility', () => {
  it('computes fragility based on weighted in-degree', () => {
    const graph = makeMockGraph(3, [
      { from: contractA, to: contractB, type: 'token', criticality: 'critical', weight: 1.0 },
      { from: contractA, to: contractC, type: 'oracle', criticality: 'low', weight: 0.15 },
    ]);
    const results = computeSystemicFragility(graph);
    const aFrag = results.find((r) => r.address === contractA);
    expect(aFrag).toBeDefined();
    expect(aFrag!.dependencies).toBeGreaterThan(0);
  });
});

describe('computeSystemicRiskIndex', () => {
  it('returns 0-1 scaled risk index', () => {
    const graph = makeMockGraph(5, [
      { from: contractA, to: contractB, type: 'oracle', criticality: 'critical', weight: 1.0 },
      { from: contractA, to: contractC, type: 'call', criticality: 'medium', weight: 0.4 },
    ]);
    const index = computeSystemicRiskIndex(graph);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThanOrEqual(1);
  });

  it('returns 0 for empty graph', () => {
    const graph = makeMockGraph(0, []);
    const index = computeSystemicRiskIndex(graph);
    expect(index).toBe(0);
  });
});

describe('computeConcentrationMetrics', () => {
  it('computes TVL and dependency concentration', () => {
    const graph = makeMockGraph(3, [
      { from: contractA, to: contractB, type: 'call', criticality: 'medium', weight: 0.4 },
    ]);
    const metrics = computeConcentrationMetrics(graph);
    expect(metrics).toHaveProperty('tvlTop3');
    expect(metrics).toHaveProperty('dependencyTop3');
    expect(metrics).toHaveProperty('ecosystemDiversity');
    expect(metrics).toHaveProperty('giniCoefficient');
  });
});

describe('simulateCascade', () => {
  it('returns null for unknown protocol', async () => {
    const result = await simulateCascade('Cunknown', 'hack');
    expect(result).toBeNull();
  });

  it('returns cascade result with affected protocols', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'Core', wasmHash: null, isToken: false },
      { address: contractB, name: 'Dep1', wasmHash: null, isToken: false },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      { contractAddress: contractB, functionArgs: { target: contractA } },
    ]);
    vi.mocked(prismaRead.portfolioSnapshot.findMany).mockResolvedValue([
      { contractAddress: contractA, assetCode: 'USDC', valueUsd: 1000000 },
    ]);
    vi.mocked(prismaRead.oracleCallback.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.ammPool.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.governanceContract.findMany).mockResolvedValue([]);

    const result = await simulateCascade(contractA, 'hack');
    expect(result).not.toBeNull();
    expect(result!.totalValueAtRisk).toBeTruthy();
    expect(result!.estimatedRecoveryTime).toContain('days');
  });
});

describe('computeCorrelationRisk', () => {
  it('computes correlation scores based on shared dependencies', () => {
    const graph = makeMockGraph(3, [
      { from: contractA, to: contractB, type: 'oracle', criticality: 'critical', weight: 1.0 },
      { from: contractC, to: contractB, type: 'oracle', criticality: 'critical', weight: 1.0 },
    ]);
    const scores = computeCorrelationRisk(graph);
    expect(scores.has(contractA)).toBe(true);
    expect(scores.has(contractB)).toBe(true);
    expect(scores.has(contractC)).toBe(true);
  });
});

// Helpers

function makeMockGraph(
  numProtocols: number,
  edges: Array<{
    from: string;
    to: string;
    type: string;
    criticality: 'critical' | 'high' | 'medium' | 'low';
    weight: number;
  }>,
) {
  const protocols = new Map<string, { address: string; name: string; type: string; tvlUsd: number }>();
  const addrs = [contractA, contractB, contractC, 'C' + 'D'.repeat(55), 'C' + 'E'.repeat(55)];
  for (let i = 0; i < numProtocols; i++) {
    protocols.set(addrs[i], {
      address: addrs[i],
      name: `P${i}`,
      type: 'contract',
      tvlUsd: 1000,
    });
  }
  return {
    protocols,
    edges: edges.map((e, idx) => ({
      ...e,
      label: `edge-${idx}`,
    })),
    metadata: { totalProtocols: numProtocols, totalEdges: edges.length, generatedAt: new Date().toISOString() },
  } as any;
}
