import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_SIZE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  DEFAULT_TIMEOUT_MS,
} from '../src/indexer/graph-traversal-db';

const prismaMock = vi.hoisted(() => ({
  contractDependency: {
    findMany: vi.fn(),
  },
}));

vi.mock('../src/db', () => ({ prisma: prismaMock }));

describe('traverseUpstream', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns only the start address when no dependencies exist', async () => {
    prismaMock.contractDependency.findMany.mockResolvedValue([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1');

    expect(result.nodes).toEqual(['C1']);
    expect(result.edges).toEqual([]);
    expect(result.depthReached).toBe(0);
    expect(result.totalNodes).toBe(1);
    expect(result.totalEdges).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('traverses one level of dependencies', async () => {
    prismaMock.contractDependency.findMany
      .mockResolvedValueOnce([
        { sourceAddress: 'C2', targetAddress: 'C1', id: 'e1' },
        { sourceAddress: 'C3', targetAddress: 'C1', id: 'e2' },
      ])
      .mockResolvedValueOnce([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 2 });

    expect(result.nodes).toContain('C1');
    expect(result.nodes).toContain('C2');
    expect(result.nodes).toContain('C3');
    expect(result.edges).toHaveLength(2);
    expect(result.depthReached).toBe(2);
    expect(result.totalNodes).toBe(3);
    expect(result.totalEdges).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('respects maxDepth option', async () => {
    // Depth 1: C2, C3 depend on C1
    prismaMock.contractDependency.findMany.mockResolvedValueOnce([
      { sourceAddress: 'C2', targetAddress: 'C1', id: 'e1' },
      { sourceAddress: 'C3', targetAddress: 'C1', id: 'e2' },
    ]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 1 });

    expect(result.nodes).toContain('C1');
    expect(result.nodes).toContain('C2');
    expect(result.nodes).toContain('C3');
    expect(result.depthReached).toBe(1);
  });

  it('respects maxNodes option', async () => {
    prismaMock.contractDependency.findMany.mockResolvedValueOnce([
      { sourceAddress: 'C2', targetAddress: 'C1', id: 'e1' },
      { sourceAddress: 'C3', targetAddress: 'C1', id: 'e2' },
    ]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 5, maxNodes: 1 });

    expect(result.truncated).toBe(true);
  });

  it('uses cursor-based pagination for large frontier batches', async () => {
    const batch1 = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      sourceAddress: `C${i + 2}`,
      targetAddress: 'C1',
      id: `e${i + 1}`,
    }));

    prismaMock.contractDependency.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 2 });

    expect(result.totalNodes).toBe(BATCH_SIZE + 1);
    // Called twice at depth 1 (batch + empty), once at depth 2 (empty)
    const cursorCall = prismaMock.contractDependency.findMany.mock.calls.find(
      (call) => call[0] && call[0].cursor,
    );
    expect(cursorCall).toBeDefined();
    expect(cursorCall[0]).toHaveProperty('cursor');
  });

  it('handles multiple cursor pages', async () => {
    const batch1 = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      sourceAddress: `C${i + 2}`,
      targetAddress: 'C1',
      id: `e${i + 1}`,
    }));
    const batch2 = Array.from({ length: 500 }, (_, i) => ({
      sourceAddress: `C${BATCH_SIZE + i + 2}`,
      targetAddress: 'C1',
      id: `e${BATCH_SIZE + i + 1}`,
    }));

    prismaMock.contractDependency.findMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 2 });

    expect(result.totalNodes).toBe(BATCH_SIZE + 500 + 1);
    expect(prismaMock.contractDependency.findMany).toHaveBeenCalledTimes(3);
  });

  it('skips already visited nodes', async () => {
    prismaMock.contractDependency.findMany
      .mockResolvedValueOnce([
        { sourceAddress: 'C2', targetAddress: 'C1', id: 'e1' },
        { sourceAddress: 'C1', targetAddress: 'C1', id: 'e2' },
      ])
      .mockResolvedValueOnce([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1', { maxDepth: 2 });

    expect(result.totalNodes).toBe(2);
    expect(result.nodes).toContain('C1');
    expect(result.nodes).toContain('C2');
  });

  it('supports backwards-compatible response shape', async () => {
    prismaMock.contractDependency.findMany.mockResolvedValue([]);

    const { traverseUpstream } = await import('../src/indexer/graph-traversal-db');
    const result = await traverseUpstream('C1');

    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result).toHaveProperty('depthReached');
    expect(result).toHaveProperty('totalNodes');
    expect(result).toHaveProperty('totalEdges');
    expect(result).toHaveProperty('truncated');
    expect(result).toHaveProperty('timedOut');
  });
});

describe('BFS constants', () => {
  it('exports expected defaults', () => {
    expect(BATCH_SIZE).toBe(1000);
    expect(DEFAULT_MAX_DEPTH).toBe(5);
    expect(DEFAULT_MAX_NODES).toBe(10000);
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);
  });
});
