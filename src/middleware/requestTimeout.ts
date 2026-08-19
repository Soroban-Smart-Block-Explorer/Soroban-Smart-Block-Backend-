/**
 * Request timeout middleware with configurable timeouts per route group.
 *
 * Prevents long-running requests (archive queries, data exports, analytics)
 * from hanging indefinitely. Routes are grouped by timeout:
 *
 * - Fast (5s): Basic queries, health checks, small lookups
 * - Normal (30s): Standard API endpoints, moderate queries
 * - Long (5min): Archive queries, analytics, data exports
 * - Extended (15min): Bulk operations, expensive computations
 *
 * Times out via early socket.destroy() to force client disconnect.
 * Respects existing request timings to avoid conflicts with proxy timeouts.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { config } from '../config';

// Timeout configurations (in milliseconds) - can be overridden via environment variables
const TIMEOUT_FAST = config.timeoutFastMs; // 5 seconds
const TIMEOUT_NORMAL = config.timeoutNormalMs; // 30 seconds
const TIMEOUT_LONG = config.timeoutLongMs; // 5 minutes
const TIMEOUT_EXTENDED = config.timeoutExtendedMs; // 15 minutes

/**
 * Route patterns mapped to their timeout category.
 * Patterns are matched against the request path in order.
 * First match wins.
 */
interface TimeoutConfig {
  pattern: RegExp;
  timeout: number;
  label: string;
}

const TIMEOUT_ROUTES: TimeoutConfig[] = [
  // Fast timeouts (5s) — lightweight endpoints
  {
    pattern: /^\/health$|^\/livez$|^\/readyz$|^\/ready$/,
    timeout: TIMEOUT_FAST,
    label: 'health-check',
  },
  {
    pattern: /^\/p2p\/status$/,
    timeout: TIMEOUT_FAST,
    label: 'p2p-status',
  },
  {
    pattern: /^\/metrics$/,
    timeout: TIMEOUT_FAST,
    label: 'metrics',
  },

  // Normal timeouts (30s) — standard API endpoints
  {
    pattern: /^\/api\/v1\/transactions(?:\/|$)/,
    timeout: TIMEOUT_NORMAL,
    label: 'transactions-api',
  },
  {
    pattern: /^\/api\/v1\/events(?:\/|$)/,
    timeout: TIMEOUT_NORMAL,
    label: 'events-api',
  },
  {
    pattern: /^\/api\/v1\/contracts(?:\/|$)/,
    timeout: TIMEOUT_NORMAL,
    label: 'contracts-api',
  },
  {
    pattern: /^\/api\/v1\/wallets\/[^/]+\/(transactions|events)$/,
    timeout: TIMEOUT_NORMAL,
    label: 'wallet-history',
  },
  {
    pattern: /^\/api\/v1\/tokens(?:\/|$)/,
    timeout: TIMEOUT_NORMAL,
    label: 'tokens-api',
  },
  {
    pattern: /^\/api\/graphql/,
    timeout: TIMEOUT_NORMAL,
    label: 'graphql',
  },
  {
    pattern: /^\/api\/billing/,
    timeout: TIMEOUT_NORMAL,
    label: 'billing-api',
  },

  // Long timeouts (5min) — analytics, archives, exports
  {
    pattern: /^\/api\/v1\/analytics\//,
    timeout: TIMEOUT_LONG,
    label: 'analytics-query',
  },
  {
    pattern: /^\/api\/v1\/archive\//,
    timeout: TIMEOUT_LONG,
    label: 'archive-query',
  },
  {
    pattern: /^\/api\/v1\/export/,
    timeout: TIMEOUT_LONG,
    label: 'data-export',
  },

  // Extended timeouts (15min) — bulk operations
  {
    pattern: /^\/api\/v1\/bulk\//,
    timeout: TIMEOUT_EXTENDED,
    label: 'bulk-operation',
  },

  // P2P ledger resolution — can be expensive (on-the-fly indexing as fallback)
  {
    pattern: /^\/p2p\/ledger\//,
    timeout: TIMEOUT_LONG,
    label: 'p2p-ledger-resolve',
  },

  // WebSocket upgrades get extended timeout (not directly affected by this middleware)
  {
    pattern: /^\/api\/v1\/ws/,
    timeout: TIMEOUT_EXTENDED,
    label: 'websocket-upgrade',
  },
];

/**
 * Resolve the timeout for a given request path.
 * Returns { timeout, label } or defaults to TIMEOUT_NORMAL if no match.
 */
function resolveTimeout(path: string): { timeout: number; label: string } {
  for (const config of TIMEOUT_ROUTES) {
    if (config.pattern.test(path)) {
      return { timeout: config.timeout, label: config.label };
    }
  }
  return { timeout: TIMEOUT_NORMAL, label: 'default' };
}

/**
 * Middleware that applies request timeouts per route group.
 * Destroys the socket if timeout is exceeded.
 */
export function requestTimeout(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Capture request path early
    const path = _req.path || _req.url.split('?')[0];
    const { timeout, label } = resolveTimeout(path);

    // Attach timeout label to request for logging/debugging
    (res as any).timeoutLabel = label;

    // Enforce timeout via socket destruction if response hasn't started
    const timeoutHandle = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('[timeout] Request exceeded limit', {
          method: _req.method,
          path,
          label,
          timeoutMs: timeout,
          remoteAddr: _req.ip,
        });

        // Set response status and destroy socket to force client disconnect
        res.status(408).json({
          error: 'Request Timeout',
          message: `Request exceeded ${timeout}ms timeout limit for ${label}`,
          code: 'REQUEST_TIMEOUT',
        });

        // Force close the socket
        if (_req.socket && !_req.socket.destroyed) {
          _req.socket.destroy();
        }
      }
    }, timeout);

    // Clear timeout when response is sent (headers or body)
    res.on('finish', () => {
      clearTimeout(timeoutHandle);
    });

    res.on('close', () => {
      clearTimeout(timeoutHandle);
    });

    // Handle errors during timeout setup
    res.on('error', () => {
      clearTimeout(timeoutHandle);
    });

    next();
  };
}

/**
 * Export timeout configuration for monitoring/telemetry.
 * Useful for dashboards showing which routes have which timeouts.
 */
export function getTimeoutConfig(): Record<string, number> {
  const config: Record<string, number> = {};
  for (const route of TIMEOUT_ROUTES) {
    config[route.label] = route.timeout;
  }
  return config;
}

/**
 * Configure custom timeout for a specific path pattern.
 * This is an advanced feature for testing or overriding timeouts.
 * Call before mounting the middleware.
 *
 * @example
 * setCustomTimeout(/^\/api\/v1\/custom/, 60_000, 'custom-endpoint');
 */
export function setCustomTimeout(pattern: RegExp, timeout: number, label: string): void {
  // Insert at beginning so custom routes take precedence
  TIMEOUT_ROUTES.unshift({
    pattern,
    timeout,
    label,
  });
  logger.debug('[timeout] Custom timeout configured', { pattern: pattern.source, timeout, label });
}
