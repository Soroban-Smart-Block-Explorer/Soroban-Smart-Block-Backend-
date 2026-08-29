import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet, cacheDelete } from '../cache';
import { logger } from '../logger';

const BRUTE_FAIL_PREFIX = 'auth:brute:fail:';
const BRUTE_LOCK_PREFIX = 'auth:brute:lock:';
const IP_LIMIT_PREFIX = 'auth:ratelimit:ip:';

export interface LockoutStatus {
  isLocked: boolean;
  retryAfterSec: number;
  attempts: number;
}

/**
 * Calculates exponential lockout duration based on consecutive failure count.
 * 5 failures -> 5 minutes
 * 10 failures -> 15 minutes
 * 15+ failures -> 60 minutes
 */
function calculateLockoutDuration(attempts: number): number {
  if (attempts >= 15) return 3600; // 1 hour
  if (attempts >= 10) return 900; // 15 minutes
  return 300; // 5 minutes
}

export async function checkAccountLockout(accountKey: string): Promise<LockoutStatus> {
  const normalized = accountKey.toLowerCase().trim();
  const lockKey = `${BRUTE_LOCK_PREFIX}${normalized}`;
  const failKey = `${BRUTE_FAIL_PREFIX}${normalized}`;

  const lockedUntil = (await cacheGet<number>(lockKey)) ?? 0;
  const attempts = (await cacheGet<number>(failKey)) ?? 0;

  if (lockedUntil > Date.now()) {
    const retryAfterSec = Math.ceil((lockedUntil - Date.now()) / 1000);
    return { isLocked: true, retryAfterSec, attempts };
  }

  return { isLocked: false, retryAfterSec: 0, attempts };
}

export async function recordAccountFailure(
  accountKey: string,
  ip?: string,
): Promise<{ attempts: number; lockedUntil: number; isNewlyLocked: boolean }> {
  const normalized = accountKey.toLowerCase().trim();
  const failKey = `${BRUTE_FAIL_PREFIX}${normalized}`;
  const lockKey = `${BRUTE_LOCK_PREFIX}${normalized}`;

  const currentAttempts = ((await cacheGet<number>(failKey)) ?? 0) + 1;
  await cacheSet(failKey, currentAttempts, 24 * 3600); // retain failure history for 24 hours

  let lockedUntil = 0;
  let isNewlyLocked = false;

  if (currentAttempts % 5 === 0) {
    const durationSec = calculateLockoutDuration(currentAttempts);
    lockedUntil = Date.now() + durationSec * 1000;
    await cacheSet(lockKey, lockedUntil, durationSec);
    isNewlyLocked = true;

    logger.warn('[brute-force] Account locked out due to repeated failures', {
      accountKey: normalized,
      attempts: currentAttempts,
      durationSec,
      ip: ip ?? 'unknown',
    });
  }

  return { attempts: currentAttempts, lockedUntil, isNewlyLocked };
}

export async function clearAccountLockout(accountKey: string): Promise<void> {
  const normalized = accountKey.toLowerCase().trim();
  await cacheDelete(`${BRUTE_FAIL_PREFIX}${normalized}`);
  await cacheDelete(`${BRUTE_LOCK_PREFIX}${normalized}`);
}

/**
 * Middleware enforcing strict rate limits on authentication endpoints (10 requests per minute per IP).
 */
export async function authRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const key = `${IP_LIMIT_PREFIX}${ip}`;
  const windowSec = 60;
  const maxAllowed = 10;

  const currentCount = ((await cacheGet<number>(key)) ?? 0) + 1;
  await cacheSet(key, currentCount, windowSec);

  if (currentCount > maxAllowed) {
    logger.warn('[authRateLimit] Auth endpoint rate limit exceeded', { ip, currentCount });
    res.setHeader('Retry-After', '60');
    res.status(429).json({
      error: 'Too Many Authentication Requests',
      message: `Authentication endpoint rate limit exceeded (${maxAllowed} req/min). Try again later.`,
      code: 'AUTH_RATE_LIMITED',
    });
    return;
  }

  next();
}
