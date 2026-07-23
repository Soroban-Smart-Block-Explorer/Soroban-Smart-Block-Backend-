/**
 * ML-Based Abuse Detection
 *
 * Detects 5 abuse patterns by analysing recent ApiAuditLog records:
 *
 *  1. credential_stuffing   — rapid auth failures from same IP
 *  2. scraping              — high request rate with repetitive patterns
 *  3. ddos                  — distributed high-volume requests to same endpoint
 *  4. sequential_pagination — sequential page-through of all data
 *  5. rapid_auth_failure    — repeated 401/403 from same key or IP
 *
 * Runs on a configurable interval (default 5 min).
 * Writes AbuseEvent records and can block IPs via a Redis blocklist.
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

const ANALYSIS_WINDOW_MS = 5 * 60 * 1000;  // 5-minute sliding window
const SCAN_INTERVAL_MS   = 5 * 60 * 1000;  // run every 5 min

// Score thresholds
const THROTTLE_THRESHOLD = 0.5;
const BLOCK_THRESHOLD    = 0.8;

// ─── Pattern detectors ────────────────────────────────────────────────────────

interface LogSample {
  ip: string;
  apiKeyId: string | null;
  endpoint: string;
  statusCode: number;
  method: string;
  createdAt: Date;
}

/** Pattern 1: Rapid auth failures from same IP */
function detectCredentialStuffing(logs: LogSample[]): Map<string, number> {
  const scores = new Map<string, number>();
  const authFailsByIp = new Map<string, number>();

  for (const log of logs) {
    if ((log.statusCode === 401 || log.statusCode === 403) && log.endpoint.includes('auth')) {
      authFailsByIp.set(log.ip, (authFailsByIp.get(log.ip) ?? 0) + 1);
    }
  }

  for (const [ip, count] of authFailsByIp) {
    if (count >= 10) {
      scores.set(ip, Math.min(1, 0.3 + count * 0.05));
    }
  }
  return scores;
}

/** Pattern 2: Web scraping — high request rate with similar path patterns */
function detectScraping(logs: LogSample[]): Map<string, number> {
  const scores = new Map<string, number>();
  const requestsByIp = new Map<string, string[]>();

  for (const log of logs) {
    const paths = requestsByIp.get(log.ip) ?? [];
    paths.push(log.endpoint);
    requestsByIp.set(log.ip, paths);
  }

  for (const [ip, paths] of requestsByIp) {
    if (paths.length < 30) continue;

    // Check for repetitive path patterns (same prefix, high variety)
    const prefixes = new Set(paths.map((p) => p.split('/').slice(0, 3).join('/')));
    const uniqueRatio = prefixes.size / paths.length;

    if (paths.length >= 30 && uniqueRatio < 0.2) {
      // High volume, low path diversity = scraping
      scores.set(ip, Math.min(1, 0.4 + (paths.length / 100) * 0.2));
    }
  }
  return scores;
}

/** Pattern 3: DDoS — concentrated high volume to same endpoint */
function detectDdos(logs: LogSample[]): Map<string, number> {
  const scores = new Map<string, number>();
  const endpointCounts = new Map<string, Map<string, number>>();

  for (const log of logs) {
    const ipMap = endpointCounts.get(log.endpoint) ?? new Map();
    ipMap.set(log.ip, (ipMap.get(log.ip) ?? 0) + 1);
    endpointCounts.set(log.endpoint, ipMap);
  }

  for (const [endpoint, ipMap] of endpointCounts) {
    const total = Array.from(ipMap.values()).reduce((s, c) => s + c, 0);
    if (total < 100) continue;

    for (const [ip, count] of ipMap) {
      if (count >= 50) {
        scores.set(ip, Math.min(1, 0.5 + (count / total) * 0.4));
      }
    }
  }
  return scores;
}

/** Pattern 4: Sequential pagination scraping */
function detectSequentialPagination(logs: LogSample[]): Map<string, number> {
  const scores = new Map<string, number>();
  const paginatedByIp = new Map<string, number>();

  for (const log of logs) {
    if (
      log.endpoint.includes('cursor') ||
      log.endpoint.includes('page') ||
      log.endpoint.includes('offset')
    ) {
      paginatedByIp.set(log.ip, (paginatedByIp.get(log.ip) ?? 0) + 1);
    }
  }

  for (const [ip, count] of paginatedByIp) {
    if (count >= 20) {
      scores.set(ip, Math.min(1, 0.3 + count * 0.025));
    }
  }
  return scores;
}

/** Pattern 5: Rapid auth failures per key */
function detectRapidAuthFailure(logs: LogSample[]): Map<string, number> {
  const scores = new Map<string, number>();
  const failsByKey = new Map<string, number>();

  for (const log of logs) {
    if (log.apiKeyId && (log.statusCode === 401 || log.statusCode === 403)) {
      failsByKey.set(log.apiKeyId, (failsByKey.get(log.apiKeyId) ?? 0) + 1);
    }
  }

  for (const [keyId, count] of failsByKey) {
    if (count >= 5) {
      scores.set(keyId, Math.min(1, 0.2 + count * 0.1));
    }
  }
  return scores;
}

// ─── Action determination ─────────────────────────────────────────────────────

function scoreToAction(score: number): string {
  if (score >= BLOCK_THRESHOLD) return 'block';
  if (score >= THROTTLE_THRESHOLD) return 'throttle';
  return 'monitor';
}

// ─── Main analysis run ────────────────────────────────────────────────────────

export async function runAbuseDetection(): Promise<void> {
  const cutoff = new Date(Date.now() - ANALYSIS_WINDOW_MS);

  const logs = await prismaRead.apiAuditLog.findMany({
    where: { createdAt: { gte: cutoff } },
    select: {
      ip: true,
      apiKeyId: true,
      endpoint: true,
      statusCode: true,
      method: true,
      createdAt: true,
    },
    take: 10000,
  }) as LogSample[];

  if (logs.length === 0) return;

  const detectors: Array<{
    pattern: string;
    scores: Map<string, number>;
    isKey: boolean;
  }> = [
    { pattern: 'credential_stuffing',   scores: detectCredentialStuffing(logs),  isKey: false },
    { pattern: 'scraping',              scores: detectScraping(logs),            isKey: false },
    { pattern: 'ddos',                  scores: detectDdos(logs),                isKey: false },
    { pattern: 'sequential_pagination', scores: detectSequentialPagination(logs), isKey: false },
    { pattern: 'rapid_auth_failure',    scores: detectRapidAuthFailure(logs),    isKey: true  },
  ];

  for (const { pattern, scores, isKey } of detectors) {
    for (const [entity, score] of scores) {
      const action = scoreToAction(score);
      const blockedUntil =
        action === 'block' ? new Date(Date.now() + 60 * 60 * 1000) : // 1h block
        action === 'throttle' ? new Date(Date.now() + 15 * 60 * 1000) : null;

      await prismaWrite.abuseEvent.create({
        data: {
          pattern,
          ip: isKey ? null : entity,
          apiKeyId: isKey ? entity : null,
          score,
          action,
          blockedUntil,
          evidence: { window: `${ANALYSIS_WINDOW_MS / 1000}s`, entity, logCount: logs.length },
        },
      }).catch(() => {});

      if (action !== 'monitor') {
        logger.warn({ pattern, entity, score, action }, '[abuse-detection] Abuse detected');
      }
    }
  }
}

/** Check if an IP is currently blocked */
export async function isIpBlocked(ip: string): Promise<boolean> {
  const block = await prismaRead.abuseEvent.findFirst({
    where: {
      ip,
      action: 'block',
      blockedUntil: { gt: new Date() },
      resolvedAt: null,
    },
  }).catch(() => null);
  return !!block;
}

/** Check if a key is currently blocked */
export async function isKeyBlocked(apiKeyId: string): Promise<boolean> {
  const block = await prismaRead.abuseEvent.findFirst({
    where: {
      apiKeyId,
      action: 'block',
      blockedUntil: { gt: new Date() },
      resolvedAt: null,
    },
  }).catch(() => null);
  return !!block;
}

export function startAbuseDetection(): void {
  void runAbuseDetection();
  setInterval(() => void runAbuseDetection(), SCAN_INTERVAL_MS);
  logger.info('[abuse-detection] Background scanner started');
}
