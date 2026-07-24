import { prismaRead, prismaWrite } from './db';
import { isCacheReady } from './cache';
import { getIndexerStatus } from './indexer-state';
import { getReadinessState } from './readiness';
import { getConnectedPeerCount, isP2pEnabled } from './p2p';

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
 * Overall health response structure
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  dependencies: {
    database: DependencyHealth;
    cache: DependencyHealth;
    indexer: DependencyHealth;
    worker: DependencyHealth;
    p2p: DependencyHealth;
  };
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
}

/**
 * Check database health by attempting a simple query
 */
async function checkDatabaseHealth(): Promise<DependencyHealth> {
  const startTime = Date.now();
  try {
    // Test read replica
    await prismaRead.$queryRaw`SELECT 1`;

    // Test write database
    await prismaWrite.$queryRaw`SELECT 1`;

    const responseTime = Date.now() - startTime;

    return {
      status: responseTime > 1000 ? 'degraded' : 'healthy',
      message: responseTime > 1000 ? 'High database latency' : 'Database responsive',
      details: {
        responseTimeMs: responseTime,
        readReplica: 'connected',
        writePrimary: 'connected',
      },
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
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
 * Check cache health
 */
function checkCacheHealth(): DependencyHealth {
  const ready = isCacheReady();

  return {
    status: ready ? 'healthy' : 'degraded',
    message: ready ? 'Cache operational' : 'Cache unavailable, using fallback',
    details: {
      ready,
      type: ready ? 'redis' : 'memory',
    },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Check indexer health
 */
function checkIndexerHealth(): DependencyHealth {
  const { healthy, failureReason } = getIndexerStatus();

  return {
    status: healthy ? 'healthy' : 'unhealthy',
    message: healthy ? 'Indexer operational' : `Indexer failure: ${failureReason}`,
    details: {
      healthy,
      ...(failureReason && { failureReason }),
    },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Check worker health (background jobs, price updater, etc.)
 */
function checkWorkerHealth(): DependencyHealth {
  // For now, we'll consider workers healthy if the service is running
  // In the future, this could check actual worker status, queue depths, etc.
  return {
    status: 'healthy',
    message: 'Workers operational',
    details: {
      // Could add worker-specific metrics here
    },
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Check P2P subsystem health. Single-node deployments (P2P_ENABLED unset)
 * always report healthy — this dependency only matters once P2P is on.
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
  const [database, cache, indexer, worker] = await Promise.all([
    checkDatabaseHealth(),
    Promise.resolve(checkCacheHealth()),
    Promise.resolve(checkIndexerHealth()),
    Promise.resolve(checkWorkerHealth()),
  ]);
  const p2p = checkP2pHealth();

  const dependencies = { database, cache, indexer, worker, p2p };

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

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    dependencies,
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

  const blockers = ready
    ? undefined
    : Object.entries(dependencies)
        .filter(([, status]) => !status)
        .map(([name]) => name);

  return {
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    dependencies,
    ...(blockers && blockers.length > 0 && { blockers }),
  };
}
