import { prismaRead as prisma } from '../db';

interface ContractNode {
  id: string;
  address: string;
  name: string;
  children: string[];
  parents: string[];
  callCount: number;
  depth: number;
}

interface DependencyGraph {
  nodes: ContractNode[];
  edges: Array<{ from: string; to: string; weight: number }>;
  metadata: {
    totalNodes: number;
    totalEdges: number;
    maxDepth: number;
    generatedAt: string;
  };
}

/**
 * Extract cross-contract call relationships from transaction data
 * Builds parent-child hierarchy with call frequency tracking
 */
export async function buildContractDependencyGraph(): Promise<DependencyGraph> {
  const contracts = await prisma.contract.findMany({
    select: { address: true, name: true },
  });

  const nodes: Map<string, ContractNode> = new Map();
  const edgeWeights: Map<string, number> = new Map();

  // Initialize nodes
  for (const contract of contracts) {
    nodes.set(contract.address, {
      id: contract.address,
      address: contract.address,
      name: contract.name || contract.address.slice(0, 8),
      children: [],
      parents: [],
      callCount: 0,
      depth: 0,
    });
  }

  // Find cross-contract calls from transaction data
  const transactions = await prisma.transaction.findMany({
    where: { contractAddress: { not: null } },
    select: { contractAddress: true, functionArgs: true },
    take: 10000,
  });

  for (const tx of transactions) {
    if (!tx.contractAddress || !tx.functionArgs) continue;

    const calledAddresses = new Set(
      extractCalledAddresses(tx.functionArgs as Record<string, unknown>),
    );

    for (const called of calledAddresses) {
      if (nodes.has(called) && called !== tx.contractAddress) {
        const edgeKey = `${tx.contractAddress}->${called}`;
        edgeWeights.set(edgeKey, (edgeWeights.get(edgeKey) ?? 0) + 1);

        const node = nodes.get(tx.contractAddress);
        const targetNode = nodes.get(called);
        if (node && !node.children.includes(called)) {
          node.children.push(called);
        }
        if (targetNode && !targetNode.parents.includes(tx.contractAddress)) {
          targetNode.parents.push(tx.contractAddress);
        }
        if (node) {
          node.callCount++;
        }
      }
    }
  }

  // Calculate depths using BFS
  const depths = calculateDepths(nodes);

  const edges = Array.from(edgeWeights.entries()).map(([key, weight]) => {
    const [from, to] = key.split('->');
    return { from, to, weight };
  });

  const maxDepth = Math.max(...Array.from(depths.values()), 0);

  return {
    nodes: Array.from(nodes.values()).map((n) => ({
      ...n,
      depth: depths.get(n.address) ?? 0,
    })),
    edges,
    metadata: {
      totalNodes: nodes.size,
      totalEdges: edges.length,
      maxDepth,
      generatedAt: new Date().toISOString(),
    },
  };
}

function calculateDepths(nodes: Map<string, ContractNode>): Map<string, number> {
  const depths = new Map<string, number>();
  const visited = new Set<string>();
  let currentDepth = 0;

  // Find root nodes (no incoming edges)
  const incomingEdges = new Map<string, number>();
  for (const node of nodes.values()) {
    for (const child of node.children) {
      incomingEdges.set(child, (incomingEdges.get(child) ?? 0) + 1);
    }
  }

  let roots = Array.from(nodes.keys()).filter((addr) => !incomingEdges.has(addr));
  if (roots.length === 0) {
    roots = Array.from(nodes.keys());
  }

  // BFS from roots
  let queue = roots;
  while (queue.length > 0) {
    const nextQueue: string[] = [];
    for (const addr of queue) {
      if (visited.has(addr)) continue;
      visited.add(addr);
      depths.set(addr, currentDepth);

      const node = nodes.get(addr);
      if (node) {
        for (const child of node.children) {
          if (!visited.has(child)) {
            nextQueue.push(child);
          }
        }
      }
    }
    queue = nextQueue;
    currentDepth++;
  }

  return depths;
}

function extractCalledAddresses(obj: Record<string, unknown>): string[] {
  const addresses: string[] = [];
  const visited = new Set<unknown>();

  function traverse(val: unknown) {
    if (visited.has(val)) return;
    visited.add(val);

    if (typeof val === 'string' && isContractAddress(val)) {
      addresses.push(val);
    } else if (typeof val === 'object' && val !== null) {
      for (const v of Object.values(val)) {
        traverse(v);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        traverse(item);
      }
    }
  }

  traverse(obj);
  return addresses;
}

function isContractAddress(str: string): boolean {
  return str.startsWith('C') && str.length === 56;
}

/**
 * Generate SVG visualization of contract dependency graph
 * Uses hierarchical layout based on call depth
 */
export function generateDependencyGraphSVG(graph: DependencyGraph): string {
  const width = 1400;
  const height = 900;
  const nodeRadius = 35;

  // Hierarchical layout based on depth
  const positions = layoutNodesByDepth(graph.nodes, width, height);

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
        <polygon points="0 0, 10 3, 0 6" fill="#666" />
      </marker>
      <style>
        .node-label { font-family: monospace; font-size: 11px; font-weight: bold; }
        .edge-label { font-family: monospace; font-size: 9px; fill: #666; }
      </style>
    </defs>
    <rect width="${width}" height="${height}" fill="#fafafa" />`;

  // Draw edges with weights
  for (const edge of graph.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from && to) {
      const strokeWidth = Math.min(4, 1 + Math.log(edge.weight + 1) * 0.5);
      svg += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#999" stroke-width="${strokeWidth}" opacity="0.6" marker-end="url(#arrowhead)" />`;

      // Edge weight label
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      svg += `<text x="${midX}" y="${midY}" class="edge-label" text-anchor="middle">${edge.weight}</text>`;
    }
  }

  // Draw nodes
  for (const node of graph.nodes) {
    const pos = positions.get(node.address);
    if (!pos) continue;

    // Color by depth and call frequency
    const hue = (node.depth * 60) % 360;
    const saturation = Math.min(100, 40 + node.callCount * 5);
    const color = `hsl(${hue}, ${saturation}%, 60%)`;

    svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${nodeRadius}" fill="${color}" stroke="#333" stroke-width="2" />`;
    svg += `<text x="${pos.x}" y="${pos.y}" text-anchor="middle" dy="0.3em" class="node-label" fill="#fff">
      ${node.name.slice(0, 5)}
    </text>`;

    // Tooltip with full info
    svg += `<title>${node.name} (Depth: ${node.depth}, Calls: ${node.callCount})</title>`;
  }

  svg += '</svg>';
  return svg;
}

interface Position {
  x: number;
  y: number;
}

function layoutNodesByDepth(
  nodes: ContractNode[],
  width: number,
  height: number,
): Map<string, Position> {
  const positions = new Map<string, Position>();
  const padding = 120;
  const usableWidth = width - 2 * padding;
  const usableHeight = height - 2 * padding;

  // Group nodes by depth
  const depthGroups = new Map<number, ContractNode[]>();
  for (const node of nodes) {
    if (!depthGroups.has(node.depth)) {
      depthGroups.set(node.depth, []);
    }
    depthGroups.get(node.depth)!.push(node);
  }

  const maxDepth = Math.max(...Array.from(depthGroups.keys()), 0);

  // Position nodes in layers
  for (const [depth, depthNodes] of depthGroups) {
    const y = padding + (depth / (maxDepth + 1)) * usableHeight;
    const nodesInLayer = depthNodes.length;

    for (let i = 0; i < nodesInLayer; i++) {
      const x = padding + ((i + 0.5) / nodesInLayer) * usableWidth;
      positions.set(depthNodes[i].address, { x, y });
    }
  }

  return positions;
}
