import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  prismaRead: {
    contract: {
      findMany: vi.fn(),
    },
    transaction: {
      findMany: vi.fn(),
    },
  },
}));

import { prismaRead } from '../src/db';
import { buildContractDependencyGraph, generateDependencyGraphSVG } from '../src/indexer/dependencyGraphCompiler';

const contractA = 'C' + 'A'.repeat(55);
const contractB = 'C' + 'B'.repeat(55);
const contractC = 'C' + 'C'.repeat(55);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildContractDependencyGraph', () => {
  it('builds hierarchical parent-child edges and weights from transaction calls', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: contractA, name: 'ContractA' },
      { address: contractB, name: 'ContractB' },
      { address: contractC, name: 'ContractC' },
    ]);
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      {
        contractAddress: contractA,
        functionArgs: { target: contractB },
      },
      {
        contractAddress: contractA,
        functionArgs: { targets: [contractB, contractC] },
      },
    ]);

    const graph = await buildContractDependencyGraph();

    expect(graph.metadata.totalNodes).toBe(3);
    expect(graph.metadata.totalEdges).toBe(2);
    expect(graph.nodes.find((n) => n.address === contractA)?.children).toEqual([contractB, contractC]);
    expect(graph.edges).toContainEqual({ from: contractA, to: contractB, weight: 2 });
    expect(graph.edges).toContainEqual({ from: contractA, to: contractC, weight: 1 });
    expect(graph.nodes.find((n) => n.address === contractA)?.callCount).toBe(3);
  });
});

describe('generateDependencyGraphSVG', () => {
  it('renders an SVG graph with nodes, edges, and arrow markers', () => {
    const graph = {
      nodes: [
        { id: contractA, address: contractA, name: 'A', children: [contractB], callCount: 1, depth: 0 },
        { id: contractB, address: contractB, name: 'B', children: [], callCount: 0, depth: 1 },
      ],
      edges: [{ from: contractA, to: contractB, weight: 1 }],
      metadata: { totalNodes: 2, totalEdges: 1, maxDepth: 1, generatedAt: new Date().toISOString() },
    };

    const svg = generateDependencyGraphSVG(graph as any);
    expect(svg).toContain('<svg');
    expect(svg).toContain('marker-end="url(#arrowhead)"');
    expect(svg).toContain('<circle');
    expect(svg).toContain('>1</text>');
  });
});
