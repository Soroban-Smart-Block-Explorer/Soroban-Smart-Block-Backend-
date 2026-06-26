/* eslint-disable @typescript-eslint/no-explicit-any */

import { prismaRead } from '../db';

export interface AddressCluster {
  addresses: string[];
  txCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface TimingPattern {
  address: string;
  correlations: Array<{
    type: string;
    relatedTx: string;
    timeDelta: number;
    confidence: number;
  }>;
  patterns: Array<{
    type: string;
    description: string;
    frequency: number;
  }>;
}

export interface AmountCorrelation {
  address: string;
  matches: Array<{
    privateAmount: string;
    publicAmount: string;
    matchType: string;
    confidence: number;
    txHash: string;
  }>;
}

export interface TaintResult {
  address: string;
  depth: number;
  path: Array<{
    txHash: string;
    fromAddress: string;
    toAddress: string;
    amount: string;
    protocol: string;
    confidence: number;
  }>;
}

export interface GraphNode {
  id: string;
  type: 'address' | 'contract' | 'mixer';
  privacyScore?: number;
  txCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  txHash: string;
  value: string;
  protocol?: string;
  timestamp: Date;
}

export interface TransactionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    nodeCount: number;
    edgeCount: number;
    privacyTxCount: number;
    clusters: number;
  };
}

async function getTransactionsForAddress(address: string, limit = 100) {
  const txs = await prismaRead.transaction.findMany({
    where: {
      OR: [{ sourceAccount: address }, { contractAddress: address }],
    },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      hash: true,
      sourceAccount: true,
      contractAddress: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      functionName: true,
      status: true,
    },
  });

  const privacyTxs = await prismaRead.privacyTransaction.findMany({
    where: {
      participants: { has: address },
    },
    select: {
      txHash: true,
      protocols: true,
      privacyScore: true,
      totalValue: true,
      timestamp: true,
    },
  });

  return { txs, privacyTxs };
}

export async function findCommonInputClusters(limit = 200): Promise<AddressCluster[]> {
  const txs = await prismaRead.transaction.findMany({
    where: {
      sourceAccount: { not: undefined },
    },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      hash: true,
      sourceAccount: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });

  const addressTxMap = new Map<string, Set<string>>();
  for (const tx of txs) {
    const addr = tx.sourceAccount;
    if (!addressTxMap.has(addr)) addressTxMap.set(addr, new Set());
    addressTxMap.get(addr)!.add(tx.hash);
  }

  const clusters: AddressCluster[] = [];
  const visited = new Set<string>();

  for (const [addr1, txSet1] of addressTxMap) {
    if (visited.has(addr1)) continue;
    const cluster: string[] = [addr1];
    visited.add(addr1);

    for (const [addr2, txSet2] of addressTxMap) {
      if (visited.has(addr2)) continue;
      const common = new Set([...txSet1].filter((x) => txSet2.has(x)));
      if (common.size > 0) {
        cluster.push(addr2);
        visited.add(addr2);
      }
    }

    if (cluster.length > 1) {
      const addrTxs = cluster.map((a) => txs.filter((t) => t.sourceAccount === a));
      const allTxs = addrTxs.flat();
      clusters.push({
        addresses: cluster,
        txCount: allTxs.length,
        firstSeen: allTxs.reduce(
          (min, t) => (t.ledgerCloseTime < min ? t.ledgerCloseTime : min),
          allTxs[0]?.ledgerCloseTime || new Date(),
        ),
        lastSeen: allTxs.reduce(
          (max, t) => (t.ledgerCloseTime > max ? t.ledgerCloseTime : max),
          allTxs[0]?.ledgerCloseTime || new Date(),
        ),
      });
    }
  }

  return clusters;
}

export async function analyzeTiming(address: string): Promise<TimingPattern> {
  const { txs, privacyTxs } = await getTransactionsForAddress(address);
  const correlations: TimingPattern['correlations'] = [];
  const patterns: TimingPattern['patterns'] = [];

  for (const privTx of privacyTxs) {
    const nearbyTxs = txs.filter((t) => {
      const delta = Math.abs(t.ledgerCloseTime.getTime() - privTx.timestamp.getTime());
      return delta < 60000 && t.hash !== privTx.txHash;
    });

    for (const nt of nearbyTxs) {
      const delta = nt.ledgerCloseTime.getTime() - privTx.timestamp.getTime();
      correlations.push({
        type: delta < 0 ? 'precedes_private' : 'follows_private',
        relatedTx: nt.hash,
        timeDelta: Math.abs(delta),
        confidence: delta < 10000 ? 0.8 : 0.5,
      });
    }
  }

  const hourBuckets = new Map<number, number>();
  for (const tx of txs) {
    const hour = tx.ledgerCloseTime.getHours();
    hourBuckets.set(hour, (hourBuckets.get(hour) || 0) + 1);
  }
  for (const [hour, count] of hourBuckets) {
    if (count > txs.length * 0.2) {
      patterns.push({
        type: 'regular_timing',
        description: `Consistent activity at hour ${hour}:00 UTC (${count} transactions)`,
        frequency: count,
      });
    }
  }

  return { address, correlations, patterns };
}

export async function analyzeAmountCorrelation(address: string): Promise<AmountCorrelation> {
  const { privacyTxs } = await getTransactionsForAddress(address);
  const matches: AmountCorrelation['matches'] = [];

  for (const privTx of privacyTxs) {
    if (!privTx.totalValue) continue;
    const amount = privTx.totalValue;
    const amtNum = parseFloat(amount);

    if (amtNum % 1000 === 0 && amtNum > 0) {
      matches.push({
        privateAmount: amount,
        publicAmount: amount,
        matchType: 'round_number',
        confidence: 0.6,
        txHash: privTx.txHash,
      });
    }
    if (amtNum % 10000 === 0 && amtNum > 0) {
      matches.push({
        privateAmount: amount,
        publicAmount: amount,
        matchType: 'large_round_number',
        confidence: 0.7,
        txHash: privTx.txHash,
      });
    }
  }

  return { address, matches };
}

export async function analyzeTaint(address: string, depth = 3): Promise<TaintResult> {
  const path: TaintResult['path'] = [];
  const visited = new Set<string>();
  let currentAddress = address;

  for (let d = 0; d < depth; d++) {
    if (visited.has(currentAddress)) break;
    visited.add(currentAddress);

    const txs = await prismaRead.transaction.findMany({
      where: { sourceAccount: currentAddress },
      orderBy: { ledgerSequence: 'desc' },
      take: 10,
      select: {
        hash: true,
        sourceAccount: true,
        contractAddress: true,
        ledgerCloseTime: true,
        functionName: true,
        feeCharged: true,
      },
    });

    for (const tx of txs) {
      const privTx = await prismaRead.privacyTransaction.findUnique({
        where: { txHash: tx.hash },
      });

      if (privTx) {
        path.push({
          txHash: tx.hash,
          fromAddress: tx.sourceAccount,
          toAddress: tx.contractAddress || 'unknown',
          amount: privTx.totalValue || tx.feeCharged || '0',
          protocol: privTx.protocols[0] || 'unknown',
          confidence: 0.7,
        });

        const nextAddr = privTx.participants.find((p) => p !== currentAddress);
        if (nextAddr) {
          currentAddress = nextAddr;
          break;
        }
      }
    }
  }

  return { address, depth, path };
}

export async function buildTransactionGraph(
  addresses: string[],
  depth = 2,
): Promise<TransactionGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const processed = new Set<string>();

  async function explore(addr: string, currentDepth: number) {
    if (currentDepth > depth || processed.has(addr)) return;
    processed.add(addr);

    const { txs, privacyTxs } = await getTransactionsForAddress(addr);

    const privScores = privacyTxs.map((p) => p.privacyScore || 0);
    const avgScore =
      privScores.length > 0 ? privScores.reduce((a, b) => a + b, 0) / privScores.length : undefined;

    if (!nodes.has(addr)) {
      nodes.set(addr, {
        id: addr,
        type: privacyTxs.length > 0 ? 'address' : 'address',
        privacyScore: avgScore,
        txCount: txs.length,
      });
    }

    for (const tx of txs) {
      if (tx.contractAddress && tx.contractAddress !== addr && !processed.has(tx.contractAddress)) {
        edges.push({
          source: addr,
          target: tx.contractAddress,
          txHash: tx.hash,
          value: '0',
          timestamp: tx.ledgerCloseTime,
        });
        await explore(tx.contractAddress, currentDepth + 1);
      }

      const otherTxs = await prismaRead.transaction.findMany({
        where: { hash: tx.hash, sourceAccount: { not: addr } },
        take: 5,
        select: { sourceAccount: true },
      });

      for (const ot of otherTxs) {
        if (ot.sourceAccount && !processed.has(ot.sourceAccount)) {
          edges.push({
            source: addr,
            target: ot.sourceAccount,
            txHash: tx.hash,
            value: '0',
            timestamp: tx.ledgerCloseTime,
          });
          await explore(ot.sourceAccount, currentDepth + 1);
        }
      }
    }
  }

  for (const addr of addresses) {
    await explore(addr, 0);
  }

  const clusters = await findCommonInputClusters(50);

  return {
    nodes: Array.from(nodes.values()),
    edges,
    metadata: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      privacyTxCount: nodes.size,
      clusters: clusters.length,
    },
  };
}

export async function analyzeCluster(addresses: string[]): Promise<{
  addresses: string[];
  totalTx: number;
  privacyTx: number;
  privacyRate: number;
  commonProtocols: string[];
  riskScore: number;
  totalValue: string;
}> {
  let totalTx = 0;
  let privacyTxCount = 0;
  const protocolsSet = new Set<string>();
  let totalValue = 0;
  let totalRisk = 0;

  for (const addr of addresses) {
    const { txs, privacyTxs } = await getTransactionsForAddress(addr);
    totalTx += txs.length;
    privacyTxCount += privacyTxs.length;

    for (const p of privacyTxs) {
      for (const proto of p.protocols) protocolsSet.add(proto);
      totalValue += Number(p.totalValue) || 0;
      totalRisk += (p as any).riskScore || 0;
    }
  }

  return {
    addresses,
    totalTx,
    privacyTx: privacyTxCount,
    privacyRate: totalTx > 0 ? privacyTxCount / totalTx : 0,
    commonProtocols: Array.from(protocolsSet),
    riskScore: privacyTxCount > 0 ? totalRisk / privacyTxCount : 0,
    totalValue: String(totalValue),
  };
}

export async function getEffectiveAnonymitySets(): Promise<
  Array<{
    protocol: string;
    theoreticalSet: number;
    effectiveSet: number;
    reduction: number;
    factors: string[];
  }>
> {
  const snapshots = await prismaRead.anonymitySetSnapshot.findMany({
    orderBy: { timestamp: 'desc' },
    take: 50,
    distinct: ['protocol'],
  });

  const results: Array<{
    protocol: string;
    theoreticalSet: number;
    effectiveSet: number;
    reduction: number;
    factors: string[];
  }> = [];

  for (const snap of snapshots) {
    const factors: string[] = [];
    if (snap.effectiveSetSize && snap.setSize > snap.effectiveSetSize) {
      factors.push('Timing correlations reduce effective set');
      factors.push('Common-input ownership clustering');
      factors.push('Amount fingerprinting possible');
    }

    results.push({
      protocol: snap.protocol,
      theoreticalSet: snap.setSize,
      effectiveSet: snap.effectiveSetSize || snap.setSize,
      reduction: snap.effectiveSetSize
        ? ((snap.setSize - snap.effectiveSetSize) / snap.setSize) * 100
        : 0,
      factors,
    });
  }

  return results;
}
