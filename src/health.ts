import { prismaRead, prismaWrite } from './db';
import { isCacheReady, cacheBackendType, pingRedis } from './cache';
import { getIndexerStatus } from './indexer-state';
import { getReadinessState } from './readiness';
import { getConnectedPeerCount, isP2pEnabled } from './p2p';
import { measureReplicaLag } from './db/replicaGateway';
import { getLatestLedger } from './indexer/rpc';
import { getLastIndexedLedger } from './indexer/indexer';
import { getStalenessStatus, isFeeAggregationStale } from './indexer/fee-aggregator';
import { getGasAnalyticsStalenessStatus, isGasAnalyticsStale } from './indexer/gasAnalyticsEngine';
import { config } from './config';
import { scheduler, type JobHealthSnapshot } from './scheduler/cron-scheduler';

/**
 * Health check status for individual dependencies
 */
export interface DependencyHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
  lastChecked: string;
}

/**
 * System metrics definition
 */
export interface SystemMetrics {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  cpu: {
    user: number;
    system: number;
  };
  uptime: number;
}

/**
 * Overall health response structure
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  dependencies: {
    database: DependencyHealth;
    cache: DependencyHealth;
    rpc: DependencyHealth;
    indexer: DependencyHealth;
    worker: DependencyHealth;
    p2p: DependencyHealth;
  };
  system: SystemMetrics;
  readiness: {
    ready: boolean;
    dependencies: Record<string, boolean>;
  };
}

/**
 * Liveness check - indicates if the service is alive and should not be restarted
 */
export interface LivenessResponse {
  status: 'alive' | 'dead';
  timestamp: string;
  uptime: number;
}

/**
 * Readiness check - indicates if the service can handle traffic
 */
export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  timestamp: string;
  dependencies: Record<string, boolean>;
  blockers?: string[];
  analytics?: {
    feeAggregation: ReturnType<typeof getStalenessStatus>;
    gasAnalytics: ReturnType<typeof getGasAnalyticsStalenessStatus>;
  };
}

/**
 * Check database health by attempting a simple query and checking replica lag
 */
async function checkDatabaseHealth(): Promise<DependencyHealth> {
  const startTime = Date.now();
  try {
    // Test read replica
    await prismaRead.$queryRaw`SELECT 1`;

    // Test write database
    await prismaWrite.$queryRaw`SELECT 1`;

    const responseTime = Date.now() - startTime;
    const replicaLag = await measureReplicaLag().catch(() => 0);

    const isDegraded = responseTime > 1000 || replicaLag > 2;

    return {
      status: isDegraded ? 'degraded' : 'healthy',
      message:
        replicaLag > 2
          ? `High replica lag: ${replicaLag} ledgers`
          : responseTime > 1000
            ? 'High database latency'
            : 'Database responsive',
      details: {
        responseTimeMs: responseTime,
        readReplica: 'connected',
        writePrimary: 'connected',
        replicaLagLedgers: replicaLag,
      },
      lastChecked: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: `Database connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Check cache health and Redis connectivity
 */
async function checkCacheHealth(): Promise<DependencyHealth> {
  const ready = isCacheReady();
  const type = cacheBackendType();
  const redisConnected = await pingRedis().catch(() => false);
  const isInMemoryFallback =
    type === 'memory' &&
    !!config.cacheUrl &&
    !config.cacheUrl.startsWith('memory://');

  const status = type === 'redis' && !redisConnected ? 'unhealthy' : ready ? 'healthy' : 'degraded';

  return {
    status,
    message:
      status === 'healthy'
        ? `Cache operational (${type})`
        : `Cache degraded/disconnected (${type})`,
    details: {
      ready,
      type,
      // Issue #909: Explicit cacheBackend field so consumers (dashboards,
      // health checks, and alert rules) can distinguish Redis from fallback.
      cacheBackend: type === 'redis' || type === 'sentinel' ? 'redis' : 'in-memory',
      inMemoryFallback: isInMemoryFallback,
      connected: type === 'redis' || type === 'sentinel' ? redisConnected : true,
    },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Check RPC node connectivity
 */
async function checkRpcHealth(): Promise<DependencyHealth> {
  const startTime = Date.now();
  try {
    const latestLedger = await getLatestLedger();
    const responseTime = Date.now() - startTime;

    return {
      status: responseTime > 2000 ? 'degraded' : 'healthy',
      message: `RPC responsive, latest network ledger: ${latestLedger}`,
      details: {
        responseTimeMs: responseTime,
        latestNetworkLedger: latestLedger,
      },
      lastChecked: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: `RPC node connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Check indexer health, including last indexed ledger and lag
 */
async function checkIndexerHealth(latestNetworkLedger: number | null): Promise<DependencyHealth> {
  const { healthy, failureReason } = getIndexerStatus();

  if (config.disableIndexer) {
    return {
      status: 'healthy',
      message: 'Indexer disabled (DISABLE_INDEXER=true)',
      details: {
        disabled: true,
      },
      lastChecked: new Date().toISOString(),
    };
  }

  try {
    const lastIndexed = await getLastIndexedLedger().catch(() => 0);
    const lag =
      latestNetworkLedger !== null ? Math.max(0, latestNetworkLedger - lastIndexed) : null;

    // Consider degraded/unhealthy if lag is extremely high (e.g. > 100 ledgers)
    const isLagging = lag !== null && lag > 100;
    const status = !healthy ? 'unhealthy' : isLagging ? 'degraded' : 'healthy';

    return {
      status,
      message: !healthy
        ? `Indexer failure: ${failureReason}`
        : isLagging
          ? `Indexer lagging by ${lag} ledgers`
          : 'Indexer operational',
      details: {
        healthy,
        lastIndexedLedger: lastIndexed,
        lagLedgers: lag,
        ...(failureReason && { failureReason }),
      },
      lastChecked: new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      status: 'unhealthy',
      message: `Indexer health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: {
        healthy,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Check worker health (#906) — background jobs registered with the central
 * cron scheduler (src/scheduler/cron-scheduler.ts), plus interval-managed
 * pipelines that report heartbeats into it directly (price updates, JWT key
 * rotation, indexer gap reconciliation sweeps).
 *
 * - unhealthy: any job has hit config.workerMaxConsecutiveFailures in a row.
 * - degraded:  any job with a known schedule has missed its expected window
 *              by more than config.workerStaleIntervalMultiplier intervals.
 * - healthy:   otherwise, including before any job has reported in yet
 *              (nothing to be unhealthy about on a cold start).
 */
export function checkWorkerHealth(): DependencyHealth {
  const summary = scheduler.getHealthSummary(
    config.workerStaleIntervalMultiplier,
    config.workerMaxConsecutiveFailures,
  );

  const describe = (j: JobHealthSnapshot) => j.taskName;
  const staleJobs = summary.jobs.filter((j) => j.stale).map(describe);
  const failingJobs = summary.jobs
    .filter((j) => j.consecutiveFailures >= config.workerMaxConsecutiveFailures)
    .map(describe);

  const message =
    summary.status === 'unhealthy'
      ? `Background job(s) failing repeatedly: ${failingJobs.join(', ')}`
      : summary.status === 'degraded'
        ? `Background job(s) have missed their scheduled window: ${staleJobs.join(', ')}`
        : summary.jobs.length > 0
          ? 'Workers operational'
          : 'Workers operational (no job heartbeats reported yet)';

  return {
    status: summary.status,
    message,
    details: {
      jobs: summary.jobs,
    },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Check P2P subsystem health.
 */
function checkP2pHealth(): DependencyHealth {
  if (!isP2pEnabled()) {
    return {
      status: 'healthy',
      message: 'P2P disabled (single-node mode)',
      details: { enabled: false },
      lastChecked: new Date().toISOString(),
    };
  }
  const peerCount = getConnectedPeerCount();
  return {
    status: peerCount > 0 ? 'healthy' : 'degraded',
    message: peerCount > 0 ? `Connected to ${peerCount} peer(s)` : 'No connected peers',
    details: { enabled: true, connectedPeerCount: peerCount },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Get overall health status
 */
export async function getHealthStatus(): Promise<HealthResponse> {
  const database = await checkDatabaseHealth();
  const cache = await checkCacheHealth();
  const rpc = await checkRpcHealth();

  const latestNetworkLedger =
    rpc.status !== 'unhealthy' && rpc.details ? (rpc.details.latestNetworkLedger as number) : null;

  const indexer = await checkIndexerHealth(latestNetworkLedger);
  const worker = checkWorkerHealth();
  const p2p = checkP2pHealth();

  const dependencies = { database, cache, rpc, indexer, worker, p2p };

  // Determine overall status
  const statuses = Object.values(dependencies).map((d) => d.status);
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy';

  if (statuses.includes('unhealthy')) {
    overallStatus = 'unhealthy';
  } else if (statuses.includes('degraded')) {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'healthy';
  }

  const readinessState = getReadinessState();
  const ready = Object.values(readinessState).every(Boolean);

  // Collect system metrics
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const system: SystemMetrics = {
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
    cpu: {
      user: cpu.user,
      system: cpu.system,
    },
    uptime: process.uptime(),
  };

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    dependencies,
    system,
    readiness: {
      ready,
      dependencies: readinessState,
    },
  };
}

/**
 * Get liveness status - simple check that the service is running
 */
export function getLivenessStatus(startTime: number): LivenessResponse {
  return {
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

/**
 * Get readiness status - can the service handle traffic
 */
export function getReadinessStatus(): ReadinessResponse {
  const dependencies = getReadinessState();
  const ready = Object.values(dependencies).every(Boolean);

  const blockers: string[] = ready
    ? []
    : Object.entries(dependencies)
        .filter(([, status]) => !status)
        .map(([name]) => name);

  // Issue #879: surface staleness of analytics aggregation jobs so operators
  // can detect frozen dashboards before users do.
  const feeAggregation = getStalenessStatus();
  const gasAnalytics = getGasAnalyticsStalenessStatus();

  if (isFeeAggregationStale()) {
    blockers.push('fee_aggregation_stale');
  }
  if (isGasAnalyticsStale()) {
    blockers.push('gas_analytics_stale');
  }

  const overallReady = ready && !isFeeAggregationStale() && !isGasAnalyticsStale();

  return {
    status: overallReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    dependencies,
    ...(blockers.length > 0 && { blockers }),
    analytics: {
      feeAggregation,
      gasAnalytics,
    },
  };
}
