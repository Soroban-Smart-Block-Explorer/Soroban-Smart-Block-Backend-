import {
  Address,
  ChainId,
  ChainReputationData,
  EndorsementInput,
  TrustEdgeInput,
  TrustGraph,
  TrustPath,
} from './types';
import { canonicalAddress, toNumber } from './score';

export function buildTrustGraph(chainData: ChainReputationData[]): TrustGraph {
  const nodes = new Set<Address>();
  const edges: TrustGraph['edges'] = [];
  for (const item of [...chainData].sort((a, b) => a.chainId.localeCompare(b.chainId))) {
    for (const edge of item.trustEdges ?? []) {
      const from = canonicalAddress(edge.from);
      const to = canonicalAddress(edge.to);
      nodes.add(from);
      nodes.add(to);
      edges.push({
        from,
        to,
        chainId: item.chainId,
        weight: normalizeEdgeWeight(edge.weight),
        type: edge.type,
        transactionHash: edge.transactionHash,
      });
    }
  }
  return { nodes: Array.from(nodes).sort(), edges };
}

export function findTrustPath(
  graph: TrustGraph,
  from: Address,
  to: Address,
  maxDepth = 6,
): TrustPath | null {
  const start = canonicalAddress(from);
  const end = canonicalAddress(to);
  if (start === end) return { from: start, to: end, path: [start], distance: 0, chainIds: [] };

  const adjacency = new Map<Address, Array<{ to: Address; weight: number; chainId: ChainId }>>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)?.push({ to: edge.to, weight: edge.weight, chainId: edge.chainId });
  }

  const queue: Array<{ address: Address; path: Address[]; distance: number; chainIds: ChainId[] }> =
    [{ address: start, path: [start], distance: 0, chainIds: [] }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const key = `${current.address}:${current.path.length}`;
    if (visited.has(key) || current.path.length > maxDepth) continue;
    visited.add(key);

    for (const next of adjacency.get(current.address) ?? []) {
      const nextAddress = next.to;
      const distance = current.distance + 1 / Math.max(next.weight, 0.0001);
      const path = [...current.path, nextAddress];
      const chainIds = Array.from(new Set([...current.chainIds, next.chainId])).sort();
      if (nextAddress === end)
        return { from: start, to: end, path, distance: round(distance), chainIds };
      queue.push({ address: nextAddress, path, distance, chainIds });
    }
  }

  return null;
}

export function weightEndorsement(endorsement: EndorsementInput, endorserScore: number): number {
  const base = normalizeEdgeWeight(endorsement.weight);
  const reputationFactor = 0.35 + (0.65 * Math.max(0, Math.min(endorserScore, 100))) / 100;
  return round(base * reputationFactor);
}

export function weightedEndorsements(
  endorsements: EndorsementInput[],
  endorserScores: Map<Address, number>,
): Array<Omit<EndorsementInput, 'weight'> & { weight: number }> {
  return endorsements
    .map((endorsement) => ({
      ...endorsement,
      weight: weightEndorsement(
        endorsement,
        endorserScores.get(canonicalAddress(endorsement.endorser)) ?? 0,
      ),
    }))
    .sort((a, b) => b.weight - a.weight || a.subject.localeCompare(b.subject));
}

export function normalizeEdgeWeight(value: number | string | undefined): number {
  const numeric = toNumber(value, 1);
  return Math.max(0.0001, numeric);
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
