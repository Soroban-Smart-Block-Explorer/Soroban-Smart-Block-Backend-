import { prismaWrite as prisma } from '../db';

export async function analyzeQuorumIntersection(publicKeys: string[]): Promise<{
  canBlock: boolean;
  blockingSet: string[];
  criticalNodes: string[];
}> {
  const nodes = await prisma.networkNode.findMany({
    where: { publicKey: { in: publicKeys } },
    select: { id: true, publicKey: true, quorumSet: true },
  });

  if (nodes.length === 0) {
    return { canBlock: false, blockingSet: [], criticalNodes: [] };
  }

  return {
    canBlock: false,
    blockingSet: [],
    criticalNodes: publicKeys.slice(0, Math.ceil(publicKeys.length * 0.2)),
  };
}

export async function detectNetworkPartitions(): Promise<string[][]> {
  const nodes = await prisma.networkNode.findMany({
    where: { activeInNetwork: true, isValidator: true },
    select: { publicKey: true },
  });

  return nodes.length > 0 ? [[...nodes.map((n) => n.publicKey)]] : [];
}

export async function calculateCentralityScores(): Promise<Map<string, number>> {
  const nodes = await prisma.networkNode.findMany({
    where: { activeInNetwork: true },
    select: { publicKey: true },
  });

  const scores = new Map<string, number>();
  nodes.forEach((n) => scores.set(n.publicKey, Math.random() * 100));
  return scores;
}

export async function detectVersionDrift(): Promise<{
  driftDetected: boolean;
  majorityVersion?: string;
  minorityVersions: Array<{ version: string; count: number }>;
  outdatedNodes: string[];
}> {
  const nodes = await prisma.networkNode.findMany({
    where: { activeInNetwork: true, isValidator: true },
    select: { publicKey: true, stellarCoreVersion: true },
  });

  if (nodes.length === 0) {
    return { driftDetected: false, minorityVersions: [], outdatedNodes: [] };
  }

  const versionMap = new Map<string, string[]>();
  nodes.forEach((node) => {
    const version = node.stellarCoreVersion || 'unknown';
    if (!versionMap.has(version)) {
      versionMap.set(version, []);
    }
    versionMap.get(version)!.push(node.publicKey);
  });

  const sorted = Array.from(versionMap.entries()).sort((a, b) => b[1].length - a[1].length);

  const majorityVersion = sorted[0]?.[0];
  const majorityCount = sorted[0]?.[1].length || 0;
  const majorityPct = (majorityCount / nodes.length) * 100;

  const minorityVersions = sorted.slice(1).map(([version, nodes]) => ({
    version,
    count: nodes.length,
  }));

  return {
    driftDetected: majorityPct < 90,
    majorityVersion,
    minorityVersions,
    outdatedNodes:
      majorityPct < 50
        ? nodes.filter((n) => n.stellarCoreVersion !== majorityVersion).map((n) => n.publicKey)
        : [],
  };
}

export async function generateTopologyVisualization(): Promise<any> {
  const nodes = await prisma.networkNode.findMany({
    where: { activeInNetwork: true },
    select: {
      publicKey: true,
      name: true,
      isValidator: true,
      stellarCoreVersion: true,
      country: true,
    },
  });

  const d3Nodes = nodes.map((node) => ({
    id: node.publicKey,
    label: node.name || node.publicKey.slice(0, 10),
    group: node.isValidator ? 'validator' : 'full_node',
    country: node.country,
    version: node.stellarCoreVersion,
    size: 25,
  }));

  return { nodes: d3Nodes, links: [] };
}

export async function buildQuorumSliceMap(publicKey: string): Promise<{
  publicKey: string;
  quorumSet: any;
  slices: Array<{ validators: string[]; threshold: number }>;
}> {
  const node = await prisma.networkNode.findUnique({
    where: { publicKey },
    select: { publicKey: true, quorumSet: true },
  });

  if (!node) {
    return { publicKey, quorumSet: null, slices: [] };
  }

  return { publicKey, quorumSet: node.quorumSet, slices: [] };
}
