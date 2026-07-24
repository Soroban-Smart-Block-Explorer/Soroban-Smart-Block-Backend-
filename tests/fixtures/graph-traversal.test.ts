import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all external dependencies BEFORE importing modules under test ────────
vi.mock('../../src/db', () => {
  const findMany = vi.fn();
  return {
    prisma: { contractDependency: { findMany } },
  };
});

import { prisma } from '../../src/db';
const findMany = (prisma.contractDependency as { findMany: ReturnType<typeof vi.fn> }).findMany;

import { traverseUpstream, traverseDownstream } from '../../src/indexer/graph-traversal-db';

// ── Address Helper ──────────────────────────────────────────────────────────
function addr(n: number): string {
  return `C${String(n).padStart(55, '0')}`;
}

type EdgeRow = { id: string; sourceAddress: string; targetAddress: string; isActive: boolean };

// ── Chain Builder ──────────────────────────────────────────────────────────
function buildChain(length: number): EdgeRow[] {
  return Array.from({ length: length - 1 }, (_, i) => ({
    id: `edge-${String(i).padStart(10, '0')}`,
    sourceAddress: addr(i),
    targetAddress: addr(i + 1),
    isActive: true,
  }));
}

// ── makeChainLoader ─────────────────────────────────────────────────────────
export function makeChainLoader(allRows: EdgeRow[], direction: 'upstream' | 'downstream') {
  // Build lookup maps for O(1) retrieval
  const lookupMap = new Map<string, EdgeRow[]>();

  for (const row of allRows) {
    const key = direction === 'upstream' ? row.targetAddress : row.sourceAddress;
    if (!lookupMap.has(key)) {
      lookupMap.set(key, []);
    }
    lookupMap.get(key)!.push(row);
  }

  // Build an ID-to-index map per lookup key for fast cursor slicing
  const cursorMap = new Map<string, Map<string, number>>();
  for (const [key, rows] of lookupMap.entries()) {
    const idxMap = new Map<string, number>();
    rows.forEach((row, index) => {
      idxMap.set(row.id, index);
    });
    cursorMap.set(key, idxMap);
  }

  return {
    readFunc: async (args: {
      where?: {
        sourceAddress?: { in: string[] };
        targetAddress?: { in: string[] };
      };
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const { where, take = 1000, cursor, skip } = args;
      const frontier =
        direction === 'upstream' ? where?.targetAddress?.in : where?.sourceAddress?.in;

      if (!frontier || frontier.length === 0) {
        return [];
      }

      const results: EdgeRow[] = [];
      for (const address of frontier) {
        const rows = lookupMap.get(address);
        if (!rows) continue;

        let startIdx = 0;
        if (cursor?.id) {
          const idxMap = cursorMap.get(address);
          const cursorIdx = idxMap ? idxMap.get(cursor.id) : undefined;
          if (cursorIdx !== undefined) {
            startIdx = cursorIdx + (skip ?? 1);
          } else {
            startIdx = rows.length; // cursor not found in this subset
          }
        }

        results.push(...rows.slice(startIdx, startIdx + take));
      }

      return results.slice(0, take);
    },
  };
}

describe('bfsPaginatedReachable - 50k-edge synthetic fixture (597 / 574 / 575 acceptance bench)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs upstream traversal on 50k-edge chain under budget', async () => {
    const N = 50_000;
    const rows = buildChain(N + 1);

    const loader = makeChainLoader(rows, 'upstream');
    findMany.mockImplementation(loader.readFunc);

    const startTime = Date.now();
    const result = await traverseUpstream(addr(N), {
      maxDepth: 60000,
      maxNodes: 60000,
      timeoutMs: 30000,
    });
    const duration = Date.now() - startTime;

    console.log(`Upstream 50k benchmark took ${duration}ms`);

    expect(duration).toBeLessThan(10000); // Must be well under 10 seconds
    expect(result.totalNodes).toBe(N + 1);
    expect(result.totalEdges).toBe(N);
    expect(result.depthReached).toBe(N + 1);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('runs downstream traversal on 50k-edge chain under budget', async () => {
    const N = 50_000;
    const rows = buildChain(N + 1);

    const loader = makeChainLoader(rows, 'downstream');
    findMany.mockImplementation(loader.readFunc);

    const startTime = Date.now();
    const result = await traverseDownstream(addr(0), {
      maxDepth: 60000,
      maxNodes: 60000,
      timeoutMs: 30000,
    });
    const duration = Date.now() - startTime;

    console.log(`Downstream 50k benchmark took ${duration}ms`);

    expect(duration).toBeLessThan(10000); // Must be well under 10 seconds
    expect(result.totalNodes).toBe(N + 1);
    expect(result.totalEdges).toBe(N);
    expect(result.depthReached).toBe(N + 1);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});
