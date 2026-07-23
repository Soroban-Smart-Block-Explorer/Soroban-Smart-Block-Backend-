/**
 * tests/indexer/propagation-engine.test.ts
 *
 * Covers the paginated BFS traversal logic in src/indexer/graph-traversal-db.ts
 * for both traverseUpstream and traverseDownstream, and the Express routes
 * that expose them via /api/v1/graph/contracts/:address/upstream|downstream.
 *
 * Uses a synthetic 50 000-edge in-memory fixture; no database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all external dependencies BEFORE importing modules under test ────────
// vi.mock is hoisted — all factories must be self-contained.

vi.mock('../../src/db', () => {
  const findMany = vi.fn();
  return {
    prisma: { contractDependency: { findMany } },
    prismaRead: { contractDependency: { findMany } },
    prismaWrite: { contractDependency: { findMany } },
  };
});

vi.mock('../../src/db/graph', () => ({
  getGraphDb: () => ({
    executeCypher: vi.fn().mockResolvedValue({ data: [], executionTime: 0, nodeCount: 0, edgeCount: 0 }),
    healthCheck: vi.fn().mockResolvedValue(true),
    upsertNode: vi.fn().mockResolvedValue(undefined),
    upsertEdge: vi.fn().mockResolvedValue(undefined),
    getGraphStats: vi.fn().mockResolvedValue({ nodeCount: 0, edgeCount: 0, nodeLabels: [], edgeLabels: [] }),
  }),
  resetGraphDb: vi.fn(),
}));

vi.mock('../../src/services/graphTemplates', () => ({
  getGraphTemplates: () => ({
    contractCallGraph: vi.fn().mockResolvedValue({ data: [] }),
    dependencyGraph: vi.fn().mockResolvedValue({ data: [] }),
    vulnerabilityPath: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

vi.mock('../../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/indexer/dependencyGraphCompiler', () => ({
  buildContractDependencyGraph: vi.fn().mockResolvedValue({
    nodes: [], edges: [], metadata: { totalNodes: 0, totalEdges: 0, maxDepth: 0, generatedAt: '' },
  }),
  generateDependencyGraphSVG: vi.fn().mockReturnValue('<svg/>'),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { prisma } from '../../src/db';

const findMany = (prisma.contractDependency as { findMany: ReturnType<typeof vi.fn> }).findMany;

import express, { Application } from 'express';
import request from 'supertest';
import { graphRouter } from '../../src/api/graph';

function buildApp(): Application {
  const app = express();
  app.use('/api/v1/graph', graphRouter);
  return app;
}

// ── Synthetic fixture helpers ─────────────────────────────────────────────────

function addr(n: number): string {
  return `C${String(n).padStart(55, '0')}`;
}

type EdgeRow = { id: string; sourceAddress: string; targetAddress: string };

function buildChain(length: number): EdgeRow[] {
  return Array.from({ length: length - 1 }, (_, i) => ({
    id: `edge-${String(i).padStart(10, '0')}`,
    sourceAddress: addr(i),
    targetAddress: addr(i + 1),
  }));
}

function buildFanOut(fanOut: number, maxEdges: number): EdgeRow[] {
  const rows: EdgeRow[] = [];
  let idCounter = 0;
  let nodeCounter = 0;
  const queue = [nodeCounter++];

  while (queue.length > 0 && rows.length < maxEdges) {
    const src = queue.shift()!;
    for (let i = 0; i < fanOut && rows.length < maxEdges; i++) {
      const tgt = nodeCounter++;
      rows.push({
        id: `edge-${String(idCounter++).padStart(10, '0')}`,
        sourceAddress: addr(src),
        targetAddress: addr(tgt),
      });
      queue.push(tgt);
    }
  }
  return rows;
}

/**
 * Install findMany to serve rows in pages of BATCH_SIZE=1000, replicating
 * Prisma cursor-based pagination.
 */
function mockFindMany(allRows: EdgeRow[]): void {
  const BATCH = 1000; // mirrors BATCH_SIZE in graph-traversal-db.ts

  findMany.mockImplementation(
    (args: {
      where?: {
        sourceAddress?: { in: string[] };
        targetAddress?: { in: string[] };
        isActive?: boolean;
      };
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const { where, take = BATCH, cursor, skip } = args;

      const matched = allRows.filter((row) => {
        if (where?.sourceAddress?.in && !where.sourceAddress.in.includes(row.sourceAddress)) {
          return false;
        }
        if (where?.targetAddress?.in && !where.targetAddress.in.includes(row.targetAddress)) {
          return false;
        }
        return true;
      });

      let startIdx = 0;
      if (cursor?.id) {
        const cursorIdx = matched.findIndex((r) => r.id === cursor.id);
        startIdx = cursorIdx === -1 ? matched.length : cursorIdx + (skip ?? 1);
      }

      return Promise.resolve(matched.slice(startIdx, startIdx + take));
    },
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// DOWNSTREAM BFS
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/graph/contracts/:address/downstream', () => {
  it('returns seed node only when no outgoing edges exist', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream`);

    expect(res.status).toBe(200);
    expect(res.body.startAddress).toBe(addr(0));
    expect(res.body.nodes).toEqual([addr(0)]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.timedOut).toBe(false);
    expect(res.body.totalNodes).toBe(1);
    expect(res.body.totalEdges).toBe(0);
  });

  it('traverses a 10-node linear chain completely', async () => {
    const rows = buildChain(10);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=10&maxNodes=50000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totalNodes).toBe(10);
    expect(res.body.totalEdges).toBe(9);
    expect(res.body.truncated).toBe(false);
    expect(res.body.timedOut).toBe(false);
  });

  it('respects maxDepth query parameter', async () => {
    const rows = buildChain(20);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=3`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totalNodes).toBe(4); // seed + 3 hops
    expect(res.body.truncated).toBe(false);
    expect(res.body.depthReached).toBe(3);
  });

  it('truncates when maxNodes budget is exceeded', async () => {
    const rows = buildFanOut(3, 500);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.totalNodes).toBeLessThanOrEqual(6);
  });

  it('50k-edge fan-out: pagination fires multiple times per frontier', async () => {
    const rows = buildFanOut(50_000, 50_000);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=50000&maxDepth=1&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    // BATCH_SIZE=1000, 50 000 edges → ≥50 findMany calls
    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(50);
    expect(res.body.totalEdges).toBeGreaterThan(0);
  });

  it('50k-edge fixture — maxNodes cap triggers truncation (downstream)', async () => {
    const rows = buildFanOut(10, 50_000);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=500&maxDepth=10&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.totalNodes).toBeLessThanOrEqual(501);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(typeof res.body.depthReached).toBe('number');
  });

  it('response shape is complete', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream`);

    expect(res.body).toMatchObject({
      startAddress: expect.any(String),
      nodes: expect.any(Array),
      edges: expect.any(Array),
      depthReached: expect.any(Number),
      totalNodes: expect.any(Number),
      totalEdges: expect.any(Number),
      truncated: expect.any(Boolean),
      timedOut: expect.any(Boolean),
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UPSTREAM BFS
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/graph/contracts/:address/upstream', () => {
  it('returns seed node only when no incoming edges exist', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(9)}/upstream`);

    expect(res.status).toBe(200);
    expect(res.body.startAddress).toBe(addr(9));
    expect(res.body.nodes).toEqual([addr(9)]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.totalNodes).toBe(1);
  });

  it('walks a 10-node chain upward from the tail', async () => {
    const rows = buildChain(10);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(9)}/upstream?maxDepth=10&maxNodes=50000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totalNodes).toBe(10);
    expect(res.body.totalEdges).toBe(9);
    expect(res.body.truncated).toBe(false);
  });

  it('respects maxDepth query parameter (upstream)', async () => {
    const rows = buildChain(20);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(19)}/upstream?maxDepth=3`,
    );

    expect(res.status).toBe(200);
    expect(res.body.totalNodes).toBe(4);
    expect(res.body.truncated).toBe(false);
    expect(res.body.depthReached).toBe(3);
  });

  it('truncates when maxNodes budget is exceeded (upstream)', async () => {
    const rows = buildChain(50);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(49)}/upstream?maxNodes=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.totalNodes).toBeLessThanOrEqual(6);
  });

  it('50k-edge fixture — maxNodes cap triggers truncation (upstream)', async () => {
    const rows = buildChain(50_001);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(50_000)}/upstream?maxNodes=10&maxDepth=10&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.totalNodes).toBeLessThanOrEqual(11);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
  });

  it('response shape is symmetric with downstream', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/upstream`);

    expect(res.body).toMatchObject({
      startAddress: expect.any(String),
      nodes: expect.any(Array),
      edges: expect.any(Array),
      depthReached: expect.any(Number),
      totalNodes: expect.any(Number),
      totalEdges: expect.any(Number),
      truncated: expect.any(Boolean),
      timedOut: expect.any(Boolean),
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SHARED / EDGE CASES
// ────────────────────────────────────────────────────────────────────────────

describe('BFS edge cases', () => {
  it('does not revisit nodes in a diamond graph (downstream)', async () => {
    // A→B, A→C, B→D, C→D
    const diamond: EdgeRow[] = [
      { id: 'edge-0000000001', sourceAddress: addr(0), targetAddress: addr(1) },
      { id: 'edge-0000000002', sourceAddress: addr(0), targetAddress: addr(2) },
      { id: 'edge-0000000003', sourceAddress: addr(1), targetAddress: addr(3) },
      { id: 'edge-0000000004', sourceAddress: addr(2), targetAddress: addr(3) },
    ];
    mockFindMany(diamond);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=5`,
    );

    expect(res.status).toBe(200);
    // 4 unique nodes: A, B, C, D
    expect(res.body.totalNodes).toBe(4);
    // downstream BFS deduplicates by target node: D is discovered via B→D and
    // skipped when C→D is processed (visited.has(D) = true), so 3 edges recorded
    expect(res.body.totalEdges).toBe(3);
    expect(res.body.truncated).toBe(false);
  });

  it('does not revisit nodes in a diamond graph (upstream)', async () => {
    const diamond: EdgeRow[] = [
      { id: 'edge-0000000001', sourceAddress: addr(0), targetAddress: addr(1) },
      { id: 'edge-0000000002', sourceAddress: addr(0), targetAddress: addr(2) },
      { id: 'edge-0000000003', sourceAddress: addr(1), targetAddress: addr(3) },
      { id: 'edge-0000000004', sourceAddress: addr(2), targetAddress: addr(3) },
    ];
    mockFindMany(diamond);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(3)}/upstream?maxDepth=5`,
    );

    expect(res.status).toBe(200);
    // 4 unique nodes reachable from D upstream: D, B, C, A
    expect(res.body.totalNodes).toBe(4);
    // upstream BFS deduplicates by source node: A is discovered via B→D path
    // and skipped when encountered again via C→D path, so 3 edges recorded
    expect(res.body.totalEdges).toBe(3);
    expect(res.body.truncated).toBe(false);
  });

  it('edges use { source, target } shape (not from/to)', async () => {
    const rows = buildChain(3);
    mockFindMany(rows);
    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body.edges[0]).toHaveProperty('source');
    expect(res.body.edges[0]).toHaveProperty('target');
    expect(res.body.edges[0]).not.toHaveProperty('from');
    expect(res.body.edges[0]).not.toHaveProperty('to');
  });

  it('downstream and upstream return same response keys for isolated node', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const [downRes, upRes] = await Promise.all([
      request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream`),
      request(app).get(`/api/v1/graph/contracts/${addr(0)}/upstream`),
    ]);

    expect(Object.keys(downRes.body).sort()).toEqual(Object.keys(upRes.body).sort());
  });
});
