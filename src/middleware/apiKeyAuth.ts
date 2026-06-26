/**
 * API Key Authentication Middleware
 *
 * Reads X-Api-Key header, validates against DevApiKey table (hash comparison),
 * enforces IP whitelist, endpoint whitelist, expiry, and revocation.
 * Attaches key metadata to req.apiKey for use by downstream middlewares.
 */

import crypto from 'crypto';
import * as ipaddr from 'ipaddr.js';
import type { Request, Response, NextFunction } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import type { RateLimitTier } from './tokenBucket';

export interface ApiKeyContext {
  id: string;
  keyName: string;
  developerId: string;
  tier: RateLimitTier;
  rateLimitOverride?: number;
  allowedIps?: string[];
  allowedEndpoints?: string[];
  allowedDomains?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyContext;
      rateLimitResult?: import('./tokenBucket').TokenBucketResult;
    }
  }
}

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  try {
    // ipaddr.process normalizes IPv4-mapped IPv6 (::ffff:x.x.x.x) to plain IPv4
    const addr = ipaddr.process(ip);
    if (cidr.includes('/')) {
      const range = ipaddr.parseCIDR(cidr);
      if (addr.kind() === 'ipv4' && range[0].kind() === 'ipv4') {
        return (addr as ipaddr.IPv4).match(range as [ipaddr.IPv4, number]);
      }
      if (addr.kind() === 'ipv6' && range[0].kind() === 'ipv6') {
        return (addr as ipaddr.IPv6).match(range as [ipaddr.IPv6, number]);
      }
      return false;
    }
    return ipaddr.process(cidr).toString() === addr.toString();
  } catch {
    return false;
  }
}

// Extract the effective origin hostname from Origin or Referer headers.
// Returns null when neither header is present or parseable.
function extractOriginHost(req: Request): string | null {
  const origin = req.headers['origin'] as string | undefined;
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  }
  const referer = req.headers['referer'] as string | undefined;
  if (referer) {
    try {
      return new URL(referer).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

function domainAllowed(host: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  return allowedDomains.some((pattern) => {
    if (pattern.startsWith('*.')) {
      // *.example.com matches sub.example.com but NOT bare example.com
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function endpointAllowed(path: string, allowedEndpoints: string[]): boolean {
  if (allowedEndpoints.length === 0) return true;
  return allowedEndpoints.some((pattern) => {
    if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}

// Cache resolved keys for 60s to avoid DB lookup on every request.
// Keyed by SHA-256 digest so raw credentials never remain in process memory.
const keyCache = new Map<string, { ctx: ApiKeyContext | null; expiresAt: number }>();
const KEY_CACHE_TTL = 60_000;

/** Exposed for testing only — do not call in production code. */
export function _keyCacheKeys(): string[] {
  return Array.from(keyCache.keys());
}

/** Exposed for testing only — do not call in production code. */
export function _clearKeyCache(): void {
  keyCache.clear();
}

async function resolveApiKey(raw: string): Promise<ApiKeyContext | null> {
  const hash = hashKey(raw);
  const cached = keyCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  const record = await prismaRead.devApiKey
    .findFirst({
      where: { keyHash: hash, status: 'active' },
      select: {
        id: true,
        name: true,
        developerId: true,
        tier: true,
        rateLimitOverride: true,
        allowedIps: true,
        allowedEndpoints: true,
        allowedDomains: true,
        expiresAt: true,
        revokedAt: true,
      },
    })
    .catch(() => null);

  let ctx: ApiKeyContext | null = null;

  if (record && !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date())) {
    ctx = {
      id: record.id,
      keyName: record.name,
      developerId: record.developerId,
      tier: (record.tier as RateLimitTier) ?? 'free',
      rateLimitOverride: record.rateLimitOverride ?? undefined,
      allowedIps: Array.isArray(record.allowedIps) ? (record.allowedIps as string[]) : undefined,
      allowedEndpoints: Array.isArray(record.allowedEndpoints)
        ? (record.allowedEndpoints as string[])
        : undefined,
      allowedDomains: Array.isArray(record.allowedDomains)
        ? (record.allowedDomains as string[])
        : undefined,
    };

    // Update lastUsedAt + usageCount async (non-blocking)
    prismaWrite.devApiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
      })
      .catch(() => {});
  }

  keyCache.set(hash, { ctx, expiresAt: Date.now() + KEY_CACHE_TTL });
  return ctx;
}

/**
 * Validates X-Api-Key if present. On success, sets req.apiKey.
 * Does NOT reject requests without a key — unauthenticated traffic is allowed
 * (subject to tighter rate limits). Use requireApiKey() to enforce auth.
 */
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = req.headers['x-api-key'] as string | undefined;
  if (!raw) return next();

  const ctx = await resolveApiKey(raw);

  if (!ctx) {
    res.status(401).json({ error: 'Invalid or revoked API key' });
    return;
  }

  // IP whitelist check
  const clientIp = req.ip ?? '';
  if (ctx.allowedIps && ctx.allowedIps.length > 0) {
    if (!ctx.allowedIps.some((cidr) => ipMatchesCidr(clientIp, cidr))) {
      logger.warn('[api-key] IP not in whitelist', { keyId: ctx.id, ip: clientIp });
      res.status(403).json({ error: 'IP address not permitted for this key' });
      return;
    }
  }

  // Domain whitelist check (Origin then Referer)
  if (ctx.allowedDomains && ctx.allowedDomains.length > 0) {
    const host = extractOriginHost(req);
    if (!host || !domainAllowed(host, ctx.allowedDomains)) {
      logger.warn('[api-key] domain not in whitelist', { keyId: ctx.id, host });
      res.status(403).json({ error: 'Origin domain not permitted for this key' });
      return;
    }
  }

  // Endpoint whitelist check
  if (ctx.allowedEndpoints && ctx.allowedEndpoints.length > 0) {
    if (!endpointAllowed(req.path, ctx.allowedEndpoints)) {
      res.status(403).json({ error: 'Endpoint not permitted for this key' });
      return;
    }
  }

  req.apiKey = ctx;
  next();
}

/** Hard-require a valid API key. */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }
  next();
}

/** Require a specific tier or higher. */
export function requireKeyTier(minTier: RateLimitTier) {
  const order: RateLimitTier[] = ['unauthenticated', 'free', 'developer', 'pro', 'enterprise'];
  return (req: Request, res: Response, next: NextFunction): void => {
    const tier = req.apiKey?.tier ?? 'unauthenticated';
    if (order.indexOf(tier) < order.indexOf(minTier)) {
      res.status(403).json({ error: `Requires ${minTier} tier or higher` });
      return;
    }
    next();
  };
}
