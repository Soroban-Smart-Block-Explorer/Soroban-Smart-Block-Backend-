import { prismaRead as prisma } from '../db';
import { buildSystemDependencyGraph, computeSystemicRiskIndex } from './systemicRisk';

interface HealthSignal {
  type: 'oracle_deviation' | 'tvl_drop' | 'volume_spike' | 'pause_event' | 'governance_attack';
  severity: 'low' | 'medium' | 'high' | 'critical';
  protocolAddress: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
}

interface SystemicAlert {
  id: string;
  type: string;
  severity: string;
  message: string;
  timestamp: Date;
  previousRiskIndex: number;
  currentRiskIndex: number;
}

const RISK_INDEX_HISTORY: Array<{ timestamp: Date; value: number }> = [];
const MAX_HISTORY = 1000;
const CHECK_INTERVAL_MS = 60_000; // 1 minute
const ALERT_THRESHOLD = 0.7; // Alert when systemic risk index exceeds this

let currentRiskIndex = 0;
let previousRiskIndex = 0;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

const alerts: SystemicAlert[] = [];

/**
 * Check oracle price deviations by looking at recent OracleCallback records.
 * Unusually high latencies or failed callbacks indicate oracle issues.
 */
async function checkOracleHealth(): Promise<HealthSignal[]> {
  const signals: HealthSignal[] = [];

  const recentCallbacks = await prisma.oracleCallback.findMany({
    where: {
      requestTimestamp: {
        gte: new Date(Date.now() - 3600_000), // last hour
      },
    },
    orderBy: { requestTimestamp: 'desc' },
    take: 100,
  });

  for (const cb of recentCallbacks) {
    if (cb.status === 'failed' || cb.status === 'pending') {
      signals.push({
        type: 'oracle_deviation',
        severity: 'high',
        protocolAddress: cb.oracleContractAddress,
        message: `Oracle callback ${cb.status} for request from ${cb.dataRequestorAddress}`,
        value: cb.roundTripLatencyMs ?? 0,
        threshold: 5000,
        timestamp: cb.requestTimestamp,
      });
    }

    if ((cb.roundTripLatencyMs ?? 0) > 5000) {
      signals.push({
        type: 'oracle_deviation',
        severity: 'medium',
        protocolAddress: cb.oracleContractAddress,
        message: `Oracle high latency: ${cb.roundTripLatencyMs}ms`,
        value: cb.roundTripLatencyMs ?? 0,
        threshold: 5000,
        timestamp: cb.requestTimestamp,
      });
    }
  }

  return signals;
}

/**
 * Detect TVL drops in critical protocols by comparing recent PortfolioSnapshot data.
 */
async function checkTvlHealth(): Promise<HealthSignal[]> {
  const signals: HealthSignal[] = [];
  const graph = await buildSystemDependencyGraph();

  const recentSnapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { snapshotAt: 'desc' },
    take: 5000,
  });

  const latestTvl = new Map<string, number>();
  for (const snap of recentSnapshots) {
    const current = latestTvl.get(snap.contractAddress) ?? 0;
    latestTvl.set(snap.contractAddress, current + (snap.valueUsd ?? 0));
  }

  // Compare with older snapshots (simulate by checking if TVL is zero)
  for (const [addr, tvl] of Array.from(latestTvl)) {
    const node = graph.protocols.get(addr);
    if (!node || node.tvlUsd === 0) continue;

    const dropRatio = tvl / node.tvlUsd;
    if (dropRatio < 0.5 && node.tvlUsd > 10000) {
      signals.push({
        type: 'tvl_drop',
        severity: dropRatio < 0.2 ? 'critical' : 'high',
        protocolAddress: addr,
        message: `TVL dropped ${((1 - dropRatio) * 100).toFixed(1)}% for ${node.name}`,
        value: tvl,
        threshold: node.tvlUsd * 0.5,
        timestamp: new Date(),
      });
    }
  }

  return signals;
}

/**
 * Check for unusual transaction volumes from VolumeAlert records.
 */
async function checkVolumeSpikes(): Promise<HealthSignal[]> {
  const signals: HealthSignal[] = [];

  const recentAlerts = await prisma.volumeAlert.findMany({
    where: {
      detectedAt: {
        gte: new Date(Date.now() - 3600_000),
      },
    },
    orderBy: { zScore: 'desc' },
    take: 50,
  });

  for (const alert of recentAlerts) {
    signals.push({
      type: 'volume_spike',
      severity: alert.zScore > 5 ? 'critical' : alert.zScore > 3 ? 'high' : 'medium',
      protocolAddress: alert.contractAddress,
      message: `Volume spike: ${alert.currentCount} txs (z-score: ${alert.zScore.toFixed(2)})`,
      value: alert.currentCount,
      threshold: alert.baseline + 3 * alert.stdDev,
      timestamp: alert.detectedAt,
    });
  }

  return signals;
}

/**
 * Detect governance attacks by checking for unusual proposal activity.
 */
async function checkGovernanceHealth(): Promise<HealthSignal[]> {
  const signals: HealthSignal[] = [];

  const recentProposals = await prisma.governanceProposal.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 3600_000),
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  // More than 5 proposals in an hour from a single contract is suspicious
  const proposalCounts = new Map<string, number>();
  for (const p of recentProposals) {
    proposalCounts.set(p.contractAddress, (proposalCounts.get(p.contractAddress) ?? 0) + 1);
  }

  for (const [addr, count] of Array.from(proposalCounts)) {
    if (count > 5) {
      signals.push({
        type: 'governance_attack',
        severity: count > 10 ? 'critical' : 'high',
        protocolAddress: addr,
        message: `Unusual governance activity: ${count} proposals in last hour`,
        value: count,
        threshold: 5,
        timestamp: new Date(),
      });
    }
  }

  return signals;
}

/**
 * Update the systemic risk index and check if it exceeds threshold.
 */
async function updateRiskIndex(): Promise<void> {
  try {
    const graph = await buildSystemDependencyGraph();
    previousRiskIndex = currentRiskIndex;
    currentRiskIndex = computeSystemicRiskIndex(graph);

    RISK_INDEX_HISTORY.push({
      timestamp: new Date(),
      value: currentRiskIndex,
    });

    if (RISK_INDEX_HISTORY.length > MAX_HISTORY) {
      RISK_INDEX_HISTORY.shift();
    }

    if (currentRiskIndex > ALERT_THRESHOLD && previousRiskIndex <= ALERT_THRESHOLD) {
      alerts.push({
        id: `sys-${Date.now()}`,
        type: 'risk_threshold_breach',
        severity: 'critical',
        message: `Systemic risk index exceeded threshold: ${(currentRiskIndex * 100).toFixed(1)}%`,
        timestamp: new Date(),
        previousRiskIndex,
        currentRiskIndex,
      });
    }
  } catch (e) {
    console.error('[systemic-monitor] Failed to update risk index:', e);
  }
}

/**
 * Run a full health check cycle.
 */
async function runHealthCheck(): Promise<HealthSignal[]> {
  const allSignals: HealthSignal[] = [];

  try {
    const [oracle, tvl, volume, governance] = await Promise.all([
      checkOracleHealth(),
      checkTvlHealth(),
      checkVolumeSpikes(),
      checkGovernanceHealth(),
    ]);

    allSignals.push(...oracle, ...tvl, ...volume, ...governance);

    if (allSignals.length > 0) {
      const criticalSignals = allSignals.filter((s) => s.severity === 'critical');
      if (criticalSignals.length > 0) {
        console.warn(
          `[systemic-monitor] ${criticalSignals.length} critical health signals detected`,
        );
      }
    }
  } catch (e) {
    console.error('[systemic-monitor] Health check failed:', e);
  }

  await updateRiskIndex();
  return allSignals;
}

/**
 * Start the systemic risk monitor.
 */
export function startSystemicMonitor(): void {
  if (isRunning) return;
  isRunning = true;

  console.log('[systemic-monitor] Starting systemic risk monitor...');

  // Immediate first check
  runHealthCheck().catch((e) =>
    console.error('[systemic-monitor] Initial health check failed:', e),
  );

  monitorInterval = setInterval(() => {
    runHealthCheck().catch((e) =>
      console.error('[systemic-monitor] Periodic health check failed:', e),
    );
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the systemic risk monitor.
 */
export function stopSystemicMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isRunning = false;
}

/**
 * Get the current systemic risk index.
 */
export function getCurrentRiskIndex(): number {
  return currentRiskIndex;
}

/**
 * Get recent alerts.
 */
export function getAlerts(limit = 20): SystemicAlert[] {
  return alerts.slice(-limit);
}

/**
 * Get risk index history.
 */
export function getRiskIndexHistory(since?: Date): Array<{ timestamp: Date; value: number }> {
  if (since) {
    return RISK_INDEX_HISTORY.filter((h) => h.timestamp >= since);
  }
  return [...RISK_INDEX_HISTORY];
}
