import { prismaRead as prisma } from '../db';
import { fetchHorizonNetworkStats } from './horizon-client';

export async function getNetworkHealth() {
  const [nodes, latestHealth, networkStats] = await Promise.all([
    prisma.networkNode.findMany({
      where: { activeInNetwork: true },
      take: 100,
    }),
    prisma.stellarNetworkHealth.findFirst({ orderBy: { collectedAt: 'desc' } }),
    fetchHorizonNetworkStats(),
  ]);

  const organizations = new Map<string, number>();
  const countries = new Map<string, number>();

  for (const node of nodes) {
    if (node.organization) {
      organizations.set(node.organization, (organizations.get(node.organization) ?? 0) + 1);
    }
    if (node.country) {
      countries.set(node.country, (countries.get(node.country) ?? 0) + 1);
    }
  }

  const topOrganizations = [...organizations.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, nodeCount]) => ({
      name,
      nodeCount,
      validationWeight: parseFloat((nodeCount / Math.max(nodes.length, 1)).toFixed(2)),
    }));

  const geographicDistribution: Record<string, number> = {};
  for (const [country, count] of countries) {
    geographicDistribution[country] = count;
  }

  const validators = nodes.filter((n) => n.isValidator);
  const avgUptime =
    nodes.reduce((sum, n) => sum + (n.uptime30d ?? 99), 0) / Math.max(nodes.length, 1);

  const alerts: Array<{ severity: string; message: string; timestamp: string }> = [];
  const nodeCount24hAgo = latestHealth?.nodeCount ?? nodes.length;
  if (nodes.length < nodeCount24hAgo) {
    alerts.push({
      severity: 'warning',
      message: `Node count decreased by ${nodeCount24hAgo - nodes.length} in last 24h`,
      timestamp: new Date().toISOString(),
    });
  }

  const score = Math.min(100, Math.round(avgUptime));

  return {
    overall: { status: score >= 90 ? 'healthy' : score >= 70 ? 'degraded' : 'critical', score },
    nodes: {
      total: nodes.length,
      organizations: organizations.size,
      countries: countries.size,
      topOrganizations,
      geographicDistribution,
    },
    consensus: {
      roundTimeMs: latestHealth?.consensusRoundTimeMs ?? 3500,
      ledgerCloseTimeMs: latestHealth?.ledgerCloseTimeMs ?? 5000,
      latestLedger: networkStats ? parseInt(networkStats.current_ledger, 10) : 0,
      protocolVersion: networkStats?.protocol_version ?? 20,
      scpMessagesPerSecond: latestHealth?.scpMessagesPerSecond
        ? Number(latestHealth.scpMessagesPerSecond)
        : 250,
      quorumConfiguration: { threshold: 67, validators: validators.length },
    },
    alerts,
    history: {
      uptime30d: avgUptime,
      avgLedgerCloseTime30d: `${((latestHealth?.ledgerCloseTimeMs ?? 5000) / 1000).toFixed(1)}s`,
    },
  };
}

export async function listValidators(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [validators, total] = await Promise.all([
    prisma.networkNode.findMany({
      where: { isValidator: true, activeInNetwork: true },
      skip,
      take: limit,
      orderBy: { agreementRate24h: 'desc' },
    }),
    prisma.networkNode.count({ where: { isValidator: true, activeInNetwork: true } }),
  ]);

  return {
    validators: validators.map((v) => ({
      publicKey: v.publicKey,
      name: v.name,
      organization: v.organization,
      uptime24h: v.uptime24h,
      agreementRate24h: v.agreementRate24h,
      missedSlots24h: v.missedSlots24h,
      country: v.country,
    })),
    total,
    page,
    limit,
  };
}

export async function getValidatorDetail(publicKey: string) {
  const node = await prisma.networkNode.findUnique({
    where: { publicKey },
    include: {
      nodeMetrics: { orderBy: { timestamp: 'desc' }, take: 100 },
      nodeEvents: { orderBy: { timestamp: 'desc' }, take: 20 },
    },
  });

  if (!node) return null;

  return {
    publicKey: node.publicKey,
    name: node.name,
    organization: node.organization,
    isValidator: node.isValidator,
    uptime: { h24: node.uptime24h, d7: node.uptime7d, d30: node.uptime30d },
    agreement: { h24: node.agreementRate24h, d7: node.agreementRate7d, d30: node.agreementRate30d },
    missedSlots: { h24: node.missedSlots24h, d7: node.missedSlots7d },
    quorumSet: node.quorumSet,
    metrics: node.nodeMetrics,
    events: node.nodeEvents,
  };
}

export async function getNetworkHealthHistory(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const records = await prisma.stellarNetworkHealth.findMany({
    where: { collectedAt: { gte: since } },
    orderBy: { collectedAt: 'asc' },
  });

  return {
    history: records.map((r) => ({
      collectedAt: r.collectedAt.toISOString(),
      nodeCount: r.nodeCount,
      consensusRoundTimeMs: r.consensusRoundTimeMs,
      ledgerCloseTimeMs: r.ledgerCloseTimeMs,
      latestLedgerSequence: r.latestLedgerSequence?.toString(),
    })),
  };
}

export async function getNetworkHealthAlerts() {
  const health = await getNetworkHealth();
  return { alerts: health.alerts };
}
