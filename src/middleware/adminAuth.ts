/**
 * Admin authentication middleware
 *
 * Security hardening (issue #883):
 *
 *  1. Timing-safe comparison — uses crypto.timingSafeEqual on SHA-256 digests so
 *     that network-observable timing differences cannot reveal how many prefix
 *     bytes of the secret matched.
 *
 *  2. SHA-256 digest comparison — neither the plaintext token from the request
 *     nor the plaintext ADMIN_API_KEY is ever compared character-by-character.
 *     Both sides are digested with SHA-256 first; timingSafeEqual operates on
 *     the fixed-length (32-byte) digests only.
 *
 *  3. Brute-force rate limiting — a fixed-size in-process map tracks failed
 *     attempts per source IP.  After FAIL_LIMIT failures in FAIL_WINDOW_MS the
 *     IP is locked out for LOCKOUT_MS and receives a 429 response.  The counter
 *     is cleared on a successful authentication so legitimate credential updates
 *     are not penalised.
 *
 *  4. Audit logging — every authentication attempt (success or failure) is
 *     emitted as a structured log entry.  Failures include the source IP and a
 *     failure counter so they can be forwarded to a SIEM.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

// ── Rate-limit parameters ────────────────────────────────────────────────────

/** Number of failures allowed before an IP is locked out. */
const FAIL_LIMIT = 5;
/** Window in which FAIL_LIMIT failures trigger a lockout (ms). */
const FAIL_WINDOW_MS = 60_000; // 1 minute
/** How long a locked-out IP must wait before trying again (ms). */
const LOCKOUT_MS = 15 * 60_000; // 15 minutes
/** Maximum entries in the in-process map (evict oldest when full). */
const MAX_TRACKED_IPS = 10_000;

interface FailState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const failMap = new Map<string, FailState>();

function evictOldestEntry(): void {
  // Map preserves insertion order — the first key is the oldest.
  const firstKey = failMap.keys().next().value;
  if (firstKey !== undefined) failMap.delete(firstKey);
}

function getClientIp(req: Request): string {
  // Trust the leftmost IP in X-Forwarded-For only if Express trust proxy is set.
  // req.ip already reflects the trust-proxy setting from createApp().
  return req.ip ?? 'unknown';
}

function recordFailure(ip: string): FailState {
  const now = Date.now();
  let state = failMap.get(ip);

  if (!state) {
    if (failMap.size >= MAX_TRACKED_IPS) evictOldestEntry();
    state = { count: 0, windowStart: now, lockedUntil: 0 };
    failMap.set(ip, state);
  }

  // Reset window if it expired
  if (now - state.windowStart > FAIL_WINDOW_MS) {
    state.count = 0;
    state.windowStart = now;
  }

  state.count += 1;

  if (state.count >= FAIL_LIMIT) {
    state.lockedUntil = now + LOCKOUT_MS;
  }

  return state;
}

function clearFailures(ip: string): void {
  failMap.delete(ip);
}

function isLockedOut(ip: string): boolean {
  const state = failMap.get(ip);
  if (!state) return false;
  if (state.lockedUntil > Date.now()) return true;
  // Lock expired — clean up
  failMap.delete(ip);
  return false;
}

// ── Digest helpers ────────────────────────────────────────────────────────────

/** Return the SHA-256 digest of `value` as a Buffer. */
function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Constant-time equality check for two strings.
 *
 * Both inputs are hashed to a fixed-length digest so that:
 *  - timingSafeEqual operates on equal-length buffers (required by the API).
 *  - The comparison time does not vary with the number of matching prefix bytes.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = sha256(a);
  const digestB = sha256(b);
  // Buffers are always 32 bytes — timingSafeEqual requires equal lengths.
  return crypto.timingSafeEqual(digestA, digestB);
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const token = req.headers['x-admin-token'] as string | undefined;

  // ── Rate-limit check ──────────────────────────────────────────────────────
  if (isLockedOut(ip)) {
    const state = failMap.get(ip);
    const retryAfterSec = state ? Math.ceil((state.lockedUntil - Date.now()) / 1000) : 900;

    logger.warn('[adminAuth] Locked-out IP attempted access', { ip, retryAfterSec });

    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: 'Too many failed authentication attempts. Try again later.',
      retryAfter: retryAfterSec,
    });
    return;
  }

  // ── Token presence check ──────────────────────────────────────────────────
  if (!token) {
    const state = recordFailure(ip);
    logger.warn('[adminAuth] Missing admin token', { ip, failCount: state.count });
    res.status(401).json({ error: 'Unauthorized: admin token required' });
    return;
  }

  // ── Server misconfiguration guard ─────────────────────────────────────────
  if (!config.adminApiKey) {
    logger.error('[adminAuth] ADMIN_API_KEY is not configured');
    res.status(500).json({ error: 'Server misconfiguration: ADMIN_API_KEY not set' });
    return;
  }

  // ── Constant-time token verification ─────────────────────────────────────
  const isValid = timingSafeStringEqual(token, config.adminApiKey);

  if (!isValid) {
    const state = recordFailure(ip);
    logger.warn('[adminAuth] Invalid admin token presented', {
      ip,
      failCount: state.count,
      lockedOut: state.lockedUntil > Date.now(),
    });
    res.status(401).json({ error: 'Unauthorized: invalid admin token' });
    return;
  }

  // ── Success ───────────────────────────────────────────────────────────────
  clearFailures(ip);
  logger.info('[adminAuth] Admin authenticated successfully', { ip });
  req.actor = 'admin';
  next();
}
