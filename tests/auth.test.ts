import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

// ─── Mock cache so tests don't need Redis ────────────────────────────────────
const store = new Map<string, { value: unknown; expiresAt: number | null }>();
vi.mock('../src/cache', () => ({
  cacheGet: async (key: string) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) { store.delete(key); return null; }
    return entry.value;
  },
  cacheSet: async (key: string, value: unknown, ttl?: number) => {
    store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
  },
  cacheDelete: async (key: string) => { store.delete(key); },
}));

// Mock prisma
vi.mock('../src/db', () => ({
  prismaWrite: {
    walletUser: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    authSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    authEvent: {
      create: vi.fn(),
    },
  },
  prismaRead: {},
  prisma: {},
}));

import {
  createChallenge,
  consumeChallenge,
  getChallenge,
  incrementAttempts,
  checkChallengeRateLimit,
} from '../src/auth/challenge';
import { issueTokens, verifyToken, hashToken } from '../src/auth/tokens';
import { tierFromTokenHolding, hasRole, getFeatures } from '../src/auth/rbac';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

// ─── Challenge generation ─────────────────────────────────────────────────────
describe('Challenge generation', () => {
  it('creates a challenge with expected fields', async () => {
    const ch = await createChallenge('GADDRESS', 'testnet', 'explorer-web');
    expect(ch.challengeId).toMatch(/^ch_/);
    expect(ch.message).toContain('nonce:');
    expect(ch.message).toContain('appId: explorer-web');
    expect(ch.address).toBe('GADDRESS');
    expect(ch.expiresAt).toBeTruthy();
  });

  it('stores challenge retrievable by id', async () => {
    const ch = await createChallenge('GADDR', 'testnet', 'explorer-web');
    const fetched = await getChallenge(ch.challengeId);
    expect(fetched).not.toBeNull();
    expect(fetched!.challengeId).toBe(ch.challengeId);
  });

  it('consumes challenge (single-use)', async () => {
    const ch = await createChallenge('GADDR', 'testnet', 'explorer-web');
    const first = await consumeChallenge(ch.challengeId);
    expect(first).not.toBeNull();
    const second = await consumeChallenge(ch.challengeId);
    expect(second).toBeNull();
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────────
describe('Challenge rate limit', () => {
  it('allows 5 requests and blocks the 6th', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) {
      const ok = await checkChallengeRateLimit(ip);
      expect(ok).toBe(true);
    }
    const blocked = await checkChallengeRateLimit(ip);
    expect(blocked).toBe(false);
  });

  it('allows different IPs independently', async () => {
    for (let i = 0; i < 5; i++) await checkChallengeRateLimit('1.1.1.1');
    const ok = await checkChallengeRateLimit('2.2.2.2');
    expect(ok).toBe(true);
  });
});

// ─── Brute-force protection ────────────────────────────────────────────────────
describe('Verify attempt limiting', () => {
  it('increments attempt counter', async () => {
    const ch = await createChallenge('GADDR', 'testnet', 'explorer-web');
    await incrementAttempts(ch.challengeId);
    await incrementAttempts(ch.challengeId);
    const data = await getChallenge(ch.challengeId);
    expect(data!.attempts).toBe(2);
  });
});

// ─── JWT token issuance & verification ────────────────────────────────────────
describe('Token issuance', () => {
  it('issues tokens with correct claims', async () => {
    const { token, refreshToken, sessionId } = await issueTokens({
      sub: 'GABC',
      userId: 'uuid-1',
      role: 'user',
      tier: 'free',
      sessionId: 'sess_abc',
      appId: 'explorer-web',
    });
    expect(token).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    expect(sessionId).toBe('sess_abc');
  });

  it('verifies issued token successfully', async () => {
    const { token } = await issueTokens({
      sub: 'GABC',
      userId: 'uuid-1',
      role: 'developer',
      tier: 'developer',
      sessionId: 'sess_xyz',
      appId: 'explorer-api',
    });
    const payload = await verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('GABC');
    expect(payload!.role).toBe('developer');
    expect(payload!.tier).toBe('developer');
  });

  it('rejects tampered token', async () => {
    const { token } = await issueTokens({
      sub: 'GABC', userId: 'u1', role: 'user', tier: 'free', sessionId: 's1', appId: 'app',
    });
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'HACKER', role: 'admin' })).toString('base64url');
    const tampered = parts.join('.');
    const result = await verifyToken(tampered);
    expect(result).toBeNull();
  });

  it('token hash is deterministic', () => {
    const h1 = hashToken('some-token');
    const h2 = hashToken('some-token');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});

// ─── Replay attack protection ─────────────────────────────────────────────────
describe('Replay attack prevention', () => {
  it('cannot reuse the same challenge after it is consumed', async () => {
    const ch = await createChallenge('GADDR', 'testnet', 'explorer-web');
    await consumeChallenge(ch.challengeId);
    const reused = await getChallenge(ch.challengeId);
    expect(reused).toBeNull();
  });

  it('different nonces produce different messages', async () => {
    const ch1 = await createChallenge('GADDR', 'testnet', 'explorer-web');
    const ch2 = await createChallenge('GADDR', 'testnet', 'explorer-web');
    expect(ch1.message).not.toBe(ch2.message);
  });
});

// ─── Stellar signature verification ───────────────────────────────────────────
describe('Stellar signature verification', () => {
  it('valid ed25519 signature verifies correctly', () => {
    const kp = Keypair.random();
    const message = Buffer.from('test message for signing');
    const sig = kp.sign(message);
    expect(kp.verify(message, sig)).toBe(true);
  });

  it('wrong key does not verify', () => {
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();
    const message = Buffer.from('test message');
    const sig = kp1.sign(message);
    expect(kp2.verify(message, sig)).toBe(false);
  });
});

// ─── RBAC ─────────────────────────────────────────────────────────────────────
describe('RBAC tier management', () => {
  it('assigns correct tiers from token balance', () => {
    expect(tierFromTokenHolding(0)).toBe('free');
    expect(tierFromTokenHolding(99)).toBe('free');
    expect(tierFromTokenHolding(100)).toBe('developer');
    expect(tierFromTokenHolding(999)).toBe('developer');
    expect(tierFromTokenHolding(1000)).toBe('premium');
    expect(tierFromTokenHolding(9999)).toBe('premium');
    expect(tierFromTokenHolding(10000)).toBe('enterprise');
  });

  it('tier feature matrix is correct', () => {
    expect(getFeatures('free').rateLimit.perMinute).toBe(10);
    expect(getFeatures('developer').rateLimit.perMinute).toBe(100);
    expect(getFeatures('premium').rateLimit.perMinute).toBe(1000);
    expect(getFeatures('enterprise').rateLimit.perMinute).toBe(10000);
    expect(getFeatures('free').webhooks.max).toBe(0);
    expect(getFeatures('enterprise').webhooks.max).toBe('unlimited');
  });

  it('role hierarchy works correctly', () => {
    expect(hasRole('admin', 'user')).toBe(true);
    expect(hasRole('user', 'admin')).toBe(false);
    expect(hasRole('super_admin', 'admin')).toBe(true);
    expect(hasRole('premium', 'developer')).toBe(true);
  });
});
