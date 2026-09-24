/**
 * tests/call-graph.test.ts
 *
 * Covers the weighted contract-to-contract call graph in
 * src/indexer/call-graph.ts and its REST surface at
 * GET /api/v1/graph/contract-calls.
 *
 * Uses synthetic in-memory dependency rows; no database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external dependencies BEFORE importing modules under test ─────────────
const mocks = vi.hoisted(() => ({
  dependencyFindMany: vi.fn(),
  contractFindMany: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('../src/db', () => ({
  prismaRead: {
    contractDependency: { findMany: mocks.dependencyFindMany },
    contract: { findMany: mocks.contractFindMany },
  },
  prismaWrite: {},
  prisma: { contractDependency: { findMany: mocks.dependencyFindMany } },
}));

vi.mock('../src/cache', () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: mocks.cacheSet,
}));

vi.mock('../src/db/graph', () => ({
  getGraphDb: () => ({
    executeCypher: vi
      .fn()
      .mockResolvedValue({ data: [], executionTime: 0, nodeCount: 0, edgeCount: 0 }),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
  resetGraphDb: vi.fn(),
}));

vi.mock('../src/services/graphTemplates', () => ({
  getGraphTemplates: () => ({}),
}));

vi.mock('../src/indexer/dependencyGraphCompiler', () => ({
  buildContractDependencyGraph: vi.fn(),
  generateDependencyGraphSVG: vi.fn(),
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports after mocks ────────────────────────────────────────────────────────
import express, { Application } from 'express';
import request from 'supertest';
import { buildCallGraph, type CallGraphDb } from '../src/indexer/call-graph';
import { graphRouter } from '../src/api/graph';

// ── Synthetic fixture helpers ──────────────────────────────────────────────────
const A = 'A';
const B = 'B';
const C = 'C';
const D = 'D';

interface Row {
  id: string;
  sourceAddress: string;
  targetAddress: string;
  weight?: number | null;
  isActive?: boolean;
}

const ROWS: Row[] = [
  { id: 'e1', sourceAddress: A, targetAddress: B, weight: 5 },
  { id: 'e2', sourceAddress: A, targetAddress: C, weight: 3 },
  { id: 'e3', sourceAddress: B, targetAddress: D, weight: 2 },
];

interface ContractName {
  address: string;
  name: string | null;
}

/** In-memory stand-in for Prisma that honours where/cursor/take. */
function makeStubDb(rows: Row[], contracts: ContractName[] = []): CallGraphDb {
  const findMany = vi.fn(async (args: any) => {
    const where = args?.where ?? {};
    const matched = rows
      .filter((row) => {
        if (where.sourceAddress?.in && !where.sourceAddress.in.includes(row.sourceAddress))
          return false;
        if (where.targetAddress?.in && !where.targetAddress.in.includes(row.targetAddress))
          return false;
        if (where.isActive === true && row.isActive === false) return false;
        if (where.weight?.gte != null && (row.weight ?? 1) < where.weight.gte) return false;
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    let start = 0;
    if (args?.cursor?.id) {
      const index = matched.findIndex((row) => row.id === args.cursor.id);
      start = index === -1 ? matched.length : index + (args.skip ?? 1);
    }
    return matched.slice(start, start + (args?.take ?? 1000));
  });

  const contractFindMany = vi.fn(async (args: any) => {
    const wanted: string[] = args?.where?.address?.in ?? [];
    return contracts.filter((contract) => wanted.includes(contract.address));
  });

  return {
    contractDependency: { findMany },
    contract: { findMany: contractFindMany },
  };
}

function byAddress(result: Awaited<ReturnType<typeof buildCallGraph>>) {
  return Object.fromEntries(result.nodes.map((node) => [node.address, node]));
}

// ── Unit tests ─────────────────────────────────────────────────────────────────
describe('buildCallGraph (contract scope)', () => {
  it('walks downstream edges and reports depth, degrees and weight', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'downstream', maxDepth: 5 },
      makeStubDb(ROWS),
    );
    const nodes = byAddress(result);

    expect(result.metadata.scope).toBe('contract');
    expect(result.metadata.root).toBe(A);
    expect(result.metadata.direction).toBe('downstream');
    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B, C, D]);
    expect(result.edges).toHaveLength(3);
    expect(result.metadata.totalWeight).toBe(10);

    expect(nodes[A].isRoot).toBe(true);
    expect(nodes[A].depth).toBe(0);
    expect(nodes[A].outDegree).toBe(2);
    expect(nodes[B].depth).toBe(1);
    expect(nodes[C].depth).toBe(1);
    expect(nodes[D].depth).toBe(2);
    expect(nodes[B].inDegree).toBe(1);
    expect(nodes[A].callVolume).toBe(8);
  });

  it('walks upstream edges to callers', async () => {
    const result = await buildCallGraph(
      { address: D, direction: 'upstream', maxDepth: 5 },
      makeStubDb(ROWS),
    );
    const nodes = byAddress(result);

    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B, D]);
    expect(result.edges.map((e) => e.id).sort()).toEqual(['A->B', 'B->D']);
    expect(nodes[D].depth).toBe(0);
    expect(nodes[B].depth).toBe(1);
    expect(nodes[A].depth).toBe(2);
    expect(result.metadata.depthReached).toBe(2);
  });

  it('walks both directions when direction=both', async () => {
    const result = await buildCallGraph(
      { address: B, direction: 'both', maxDepth: 5 },
      makeStubDb(ROWS),
    );

    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B, C, D]);
    expect(result.edges).toHaveLength(3);
    expect(result.metadata.direction).toBe('both');
  });

  it('filters edges (and traversal) below minWeight', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'both', minWeight: 4 },
      makeStubDb(ROWS),
    );

    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B]);
    expect(result.edges.map((e) => e.id)).toEqual(['A->B']);
    expect(result.metadata.minWeight).toBe(4);
  });

  it('respects maxDepth', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'downstream', maxDepth: 1 },
      makeStubDb(ROWS),
    );
    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B, C]);
    expect(result.metadata.depthReached).toBe(1);
  });

  it('truncates when maxEdges is exceeded', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'both', maxEdges: 1 },
      makeStubDb(ROWS),
    );
    expect(result.metadata.truncated).toBe(true);
    expect(result.edges).toHaveLength(1);
  });

  it('truncates when maxNodes is exceeded', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'downstream', maxNodes: 2 },
      makeStubDb(ROWS),
    );
    expect(result.metadata.truncated).toBe(true);
    expect(result.nodes.map((n) => n.address).sort()).toEqual([A, B]);
  });

  it('returns only the root for an isolated contract', async () => {
    const result = await buildCallGraph({ address: A }, makeStubDb([]));
    expect(result.nodes.map((n) => n.address)).toEqual([A]);
    expect(result.nodes[0].isRoot).toBe(true);
    expect(result.edges).toEqual([]);
    expect(result.metadata.truncated).toBe(false);
    expect(result.metadata.depthReached).toBe(0);
  });

  it('excludes inactive dependencies by default and includes them on request', async () => {
    const rows: Row[] = [
      { id: 'e1', sourceAddress: A, targetAddress: B, weight: 1, isActive: true },
      { id: 'e2', sourceAddress: A, targetAddress: C, weight: 1, isActive: false },
    ];

    const active = await buildCallGraph({ address: A, direction: 'downstream' }, makeStubDb(rows));
    expect(active.nodes.map((n) => n.address).sort()).toEqual([A, B]);

    const all = await buildCallGraph(
      { address: A, direction: 'downstream', includeInactive: true },
      makeStubDb(rows),
    );
    expect(all.nodes.map((n) => n.address).sort()).toEqual([A, B, C]);
  });

  it('labels nodes with contract names when available', async () => {
    const result = await buildCallGraph(
      { address: A, direction: 'downstream' },
      makeStubDb(ROWS, [{ address: B, name: 'BetaSwap' }]),
    );
    const nodes = byAddress(result);
    expect(nodes[B].label).toBe('BetaSwap');
    expect(nodes[B].name).toBe('BetaSwap');
    expect(nodes[A].name).toBeNull();
    expect(nodes[A].label).toBe(A);
  });
});

describe('buildCallGraph (ecosystem scope)', () => {
  it('returns the whole bounded graph when no address is supplied', async () => {
    const result = await buildCallGraph({}, makeStubDb(ROWS));

    expect(result.metadata.scope).toBe('ecosystem');
    expect(result.metadata.root).toBeNull();
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
    expect(result.nodes.every((n) => n.depth === null)).toBe(true);
  });

  it('caps the ecosystem graph with maxEdges and flags truncation', async () => {
    const result = await buildCallGraph({ maxEdges: 2 }, makeStubDb(ROWS));
    expect(result.metadata.truncated).toBe(true);
    expect(result.edges).toHaveLength(2);
  });
});

// ── Endpoint tests ─────────────────────────────────────────────────────────────
function buildApp(): Application {
  const app = express();
  app.use('/api/v1/graph', graphRouter);
  return app;
}

function useRows(rows: Row[]): void {
  const stub = makeStubDb(rows);
  mocks.dependencyFindMany.mockImplementation(stub.contractDependency.findMany);
}

describe('GET /api/v1/graph/contract-calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.contractFindMany.mockResolvedValue([]);
    useRows(ROWS);
  });

  it('returns a weighted contract-scoped graph and caches it', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/graph/contract-calls?address=A&direction=downstream',
    );

    expect(res.status).toBe(200);
    expect(res.body.metadata.scope).toBe('contract');
    expect(res.body.metadata.cached).toBe(false);
    expect(res.body.nodes).toHaveLength(4);
    expect(res.body.edges).toHaveLength(3);
    expect(res.body.edges[0]).toHaveProperty('weight');
    expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
  });

  it('serves a cached snapshot when one exists', async () => {
    mocks.cacheGet.mockResolvedValue({
      nodes: [],
      edges: [],
      metadata: { cached: false, totalNodes: 0, totalEdges: 0 },
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/graph/contract-calls?address=A');

    expect(res.status).toBe(200);
    expect(res.body.metadata.cached).toBe(true);
    expect(mocks.dependencyFindMany).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
  });

  it('bypasses the cache when refresh=true', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/graph/contract-calls?address=A&refresh=true');

    expect(res.status).toBe(200);
    expect(mocks.cacheGet).not.toHaveBeenCalled();
    expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
  });

  it('returns an ecosystem-wide graph when address is omitted', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/graph/contract-calls');

    expect(res.status).toBe(200);
    expect(res.body.metadata.scope).toBe('ecosystem');
    expect(res.body.metadata.root).toBeNull();
  });

  it('rejects invalid direction with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/graph/contract-calls?address=A&direction=sideways');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});
