import { randomBytes } from 'crypto';
import { cacheGet, cacheSet, cacheDelete } from '../cache';

export const CHALLENGE_TTL = 300; // 5 minutes
const CHALLENGE_PREFIX = 'auth:challenge:';
const ATTEMPT_PREFIX = 'auth:attempts:';

const ACCOUNT_LOCKOUT_PREFIX = 'auth:lockout:';
const MAX_FAILED_ATTEMPTS_PER_ACCOUNT = 5;
const ACCOUNT_LOCKOUT_DURATION = 15 * 60; // 15 minutes

export interface ChallengeData {
  challengeId: string;
  address: string;
  network: string;
  appId: string;
  nonce: string;
  message: string;
  expiresAt: string;
  attempts: number;
}

export function buildChallengeMessage(
  address: string,
  nonce: string,
  appId: string,
  domain: string,
): string {
  const ts = `${new Date().toISOString()}-${nonce.slice(0, 8)}`;
  return `Sign this message to authenticate with Soroban Explorer: ${domain} ${ts} [nonce: ${nonce}] [appId: ${appId}]`;
}

export async function createChallenge(
  address: string,
  network: string,
  appId: string,
  domain = 'explorer.stellar.org',
): Promise<ChallengeData> {
  const nonce = randomBytes(16).toString('hex');
  const challengeId = `ch_${randomBytes(12).toString('hex')}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL * 1000).toISOString();
  const message = buildChallengeMessage(address, nonce, appId, domain);

  const data: ChallengeData = {
    challengeId,
    address,
    network,
    appId,
    nonce,
    message,
    expiresAt,
    attempts: 0,
  };
  await cacheSet(`${CHALLENGE_PREFIX}${challengeId}`, data, CHALLENGE_TTL);
  return data;
}

export async function getChallenge(challengeId: string): Promise<ChallengeData | null> {
  return cacheGet<ChallengeData>(`${CHALLENGE_PREFIX}${challengeId}`);
}

export async function consumeChallenge(challengeId: string): Promise<ChallengeData | null> {
  const data = await getChallenge(challengeId);
  if (!data) return null;
  await cacheDelete(`${CHALLENGE_PREFIX}${challengeId}`);
  return data;
}

export async function incrementAttempts(challengeId: string): Promise<number> {
  const data = await getChallenge(challengeId);
  if (!data) return 0;
  data.attempts += 1;
  await cacheSet(`${CHALLENGE_PREFIX}${challengeId}`, data, CHALLENGE_TTL);
  return data.attempts;
}

/** IP-based rate limit: 5 challenges per minute */
export async function checkChallengeRateLimit(ip: string): Promise<boolean> {
  const key = `${ATTEMPT_PREFIX}challenge:${ip}`;
  const count = (await cacheGet<number>(key)) ?? 0;
  if (count >= 5) return false;
  await cacheSet(key, count + 1, 60);
  return true;
}

/** Account-level lockout: returns true if account is locked. */
export async function checkAccountLockout(address: string): Promise<boolean> {
  const key = `${ACCOUNT_LOCKOUT_PREFIX}${address}`;
  const lockedUntil = (await cacheGet<number>(key)) ?? 0;
  if (lockedUntil > Date.now()) return true;
  if (lockedUntil > 0) await cacheDelete(key);
  return false;
}

/** Records a failed verification attempt for an account and locks out if threshold exceeded. */
export async function recordFailedVerify(address: string): Promise<void> {
  const key = `${ACCOUNT_LOCKOUT_PREFIX}${address}`;
  const current = (await cacheGet<number>(key)) ?? 0;
  const newCount = current + 1;
  if (newCount >= MAX_FAILED_ATTEMPTS_PER_ACCOUNT) {
    const expiresAt = Date.now() + ACCOUNT_LOCKOUT_DURATION * 1000;
    await cacheSet(key, expiresAt, ACCOUNT_LOCKOUT_DURATION);
  } else {
    await cacheSet(key, newCount, ACCOUNT_LOCKOUT_DURATION);
  }
}

/** Clears account lockout on successful verification. */
export async function clearAccountLockout(address: string): Promise<void> {
  await cacheDelete(`${ACCOUNT_LOCKOUT_PREFIX}${address}`);
}
