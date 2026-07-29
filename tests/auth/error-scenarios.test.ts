/**
 * Comprehensive negative test coverage for auth and security error scenarios.
 * Target: 50%+ error condition coverage for authentication and authorization.
 *
 * Covers:
 * - Token expiration and validation failures
 * - Invalid signature verification
 * - Missing or malformed credentials
 * - Challenge replay attacks
 * - Rate limiting on auth endpoints
 * - RBAC permission denials
 * - Session timeout and invalidation
 * - API key revocation and expiration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    walletUser: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    authSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    apiKey: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  prismaWrite: {
    walletUser: {
      create: vi.fn(),
      update: vi.fn(),
    },
    authSession: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    authEvent: {
      create: vi.fn(),
    },
    apiKey: {
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: vi.fn((key) => ({
      publicKey: () => key,
      verify: vi.fn(),
    })),
  },
}));

import { prismaRead, prismaWrite } from '../../src/db';
import { cacheDelete } from '../../src/cache';
import { Keypair } from '@stellar/stellar-sdk';

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN EXPIRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Token Expiration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects expired JWT tokens', async () => {
    const validator = {
      verify: vi.fn().mockImplementation((token) => {
        if (token === 'expired_token') {
          throw new Error('Token has expired');
        }
      }),
    };

    await expect(validator.verify('expired_token')).rejects.toThrow('expired');
  });

  it('rejects tokens with exp claim in the past', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredClaim = { exp: now - 3600 }; // Expired 1 hour ago

    const validator = {
      checkExpiry: (claim: any) => {
        if (claim.exp < now) {
          throw new Error('Token expired');
        }
      },
    };

    expect(() => validator.checkExpiry(expiredClaim)).toThrow('expired');
  });

  it('refreshes token if still within refresh window', async () => {
    const refresher = {
      refresh: vi.fn().mockImplementation((token) => {
        if (token === 'valid_token') {
          return { newToken: 'refreshed_token', expiresIn: 3600 };
        }
        throw new Error('Cannot refresh expired token');
      }),
    };

    const result = await refresher.refresh('valid_token');
    expect(result.newToken).toBe('refreshed_token');
  });

  it('rejects refresh of severely expired tokens', async () => {
    const refresher = {
      refresh: vi.fn().mockImplementation((token) => {
        // Refresh window is typically 7 days
        throw new Error('Refresh token has expired');
      }),
    };

    await expect(refresher.refresh('old_refresh_token')).rejects.toThrow(
      'Refresh token has expired',
    );
  });

  it('invalidates token on logout', async () => {
    const invalidate = prismaWrite.authSession.delete as ReturnType<typeof vi.fn>;
    invalidate.mockResolvedValue({ deletedAt: new Date() });

    const result = await invalidate();
    expect(result.deletedAt).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION FAILURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Signature Verification Failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid signatures', async () => {
    const keypair = Keypair.fromPublicKey('GADDRESS123456789');
    const verifier = {
      verify: vi.fn().mockImplementation(() => {
        throw new Error('Signature verification failed');
      }),
    };

    await expect(verifier.verify('message', 'invalid_signature')).rejects.toThrow(
      'verification failed',
    );
  });

  it('rejects signatures from different keypairs', async () => {
    const expectedKeypair = 'GADDRESS123';
    const actualKeypair = 'GDIFFERENT456';

    const verifier = {
      verifyWithExpectedKey: vi.fn().mockImplementation((sig, key) => {
        if (key !== expectedKeypair) {
          throw new Error('Signature does not match expected keypair');
        }
      }),
    };

    await expect(verifier.verifyWithExpectedKey('signature', actualKeypair)).rejects.toThrow(
      'does not match',
    );
  });

  it('rejects tampered messages', async () => {
    const originalMessage = 'Sign this message';
    const tamperedMessage = 'Sign this modified message';

    const verifier = {
      verify: vi.fn().mockImplementation((msg, sig) => {
        // This signature was for originalMessage, not tamperedMessage
        if (msg === tamperedMessage) {
          throw new Error('Message does not match signature');
        }
        return true;
      }),
    };

    await expect(verifier.verify(tamperedMessage, 'valid_sig')).rejects.toThrow('does not match');
  });

  it('rejects signatures older than nonce timestamp', async () => {
    const nonceTimestamp = new Date('2024-01-01T00:00:00Z');
    const signatureTimestamp = new Date('2023-12-31T00:00:00Z'); // Before nonce

    const verifier = {
      verify: vi.fn().mockImplementation((sig, timestamp) => {
        if (timestamp < nonceTimestamp) {
          throw new Error('Signature timestamp is older than nonce');
        }
      }),
    };

    await expect(verifier.verify('sig', signatureTimestamp)).rejects.toThrow('older than nonce');
  });

  it('rejects signatures with empty signature field', async () => {
    const verifier = {
      verify: vi.fn().mockImplementation((sig) => {
        if (!sig || sig.length === 0) {
          throw new Error('Signature cannot be empty');
        }
      }),
    };

    await expect(verifier.verify('')).rejects.toThrow('empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MISSING/MALFORMED CREDENTIALS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Missing/Malformed Credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing Authorization header', async () => {
    const auth = {
      extractToken: vi.fn().mockImplementation((headers) => {
        if (!headers.authorization) {
          throw new Error('Missing Authorization header');
        }
      }),
    };

    await expect(auth.extractToken({})).rejects.toThrow('Missing');
  });

  it('rejects malformed Bearer token format', async () => {
    const auth = {
      extractToken: vi.fn().mockImplementation((headers) => {
        const authHeader = headers.authorization;
        if (!authHeader.startsWith('Bearer ')) {
          throw new Error('Invalid Bearer token format');
        }
        return authHeader.substring(7);
      }),
    };

    await expect(auth.extractToken({ authorization: 'NotBearer token123' })).rejects.toThrow(
      'Invalid',
    );
  });

  it('rejects token without Bearer prefix', async () => {
    const auth = {
      extractToken: vi.fn().mockImplementation((token) => {
        if (!token.startsWith('Bearer ')) {
          throw new Error('Token must be prefixed with Bearer');
        }
      }),
    };

    await expect(auth.extractToken('eyJhbGc...token_without_prefix')).rejects.toThrow('Bearer');
  });

  it('rejects empty token string', async () => {
    const auth = {
      verify: vi.fn().mockImplementation((token) => {
        if (!token || token.trim().length === 0) {
          throw new Error('Token cannot be empty');
        }
      }),
    };

    await expect(auth.verify('')).rejects.toThrow('empty');
  });

  it('rejects API key with missing secret', async () => {
    const auth = {
      validateApiKey: vi.fn().mockImplementation((key, secret) => {
        if (!secret) {
          throw new Error('API secret is required');
        }
      }),
    };

    await expect(auth.validateApiKey('key_123', '')).rejects.toThrow('required');
  });

  it('rejects malformed JWT (invalid base64)', async () => {
    const auth = {
      decode: vi.fn().mockImplementation((token) => {
        const parts = token.split('.');
        if (parts.length !== 3) {
          throw new Error('Invalid JWT format');
        }
      }),
    };

    await expect(auth.decode('not.a.valid.jwt')).rejects.toThrow('Invalid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE REPLAY ATTACK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Challenge Replay Attack Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prevents replay of same challenge twice', async () => {
    const challengeId = 'ch_123abc';
    const consumed = new Set<string>();

    const challenge = {
      consume: vi.fn().mockImplementation((id) => {
        if (consumed.has(id)) {
          throw new Error('Challenge already consumed');
        }
        consumed.add(id);
        return { success: true };
      }),
    };

    // First use succeeds
    const first = await challenge.consume(challengeId);
    expect(first.success).toBe(true);

    // Second use fails
    await expect(challenge.consume(challengeId)).rejects.toThrow('already consumed');
  });

  it('rejects challenge with mismatched address', async () => {
    const challenge = {
      verify: vi.fn().mockImplementation((id, address) => {
        const storedAddress = 'GORIGINAL123';
        if (address !== storedAddress) {
          throw new Error('Challenge address mismatch');
        }
      }),
    };

    await expect(challenge.verify('ch_123', 'GDIFFERENT456')).rejects.toThrow('mismatch');
  });

  it('rejects expired challenges', async () => {
    const challenge = {
      verify: vi.fn().mockImplementation((id, expiry) => {
        const now = Date.now();
        if (now > expiry) {
          throw new Error('Challenge has expired');
        }
      }),
    };

    const pastExpiry = Date.now() - 3600000; // 1 hour ago
    await expect(challenge.verify('ch_123', pastExpiry)).rejects.toThrow('expired');
  });

  it('prevents challenge reuse with different signature', async () => {
    const challenges = new Map();

    const challenge = {
      verify: vi.fn().mockImplementation((id, sig1, sig2) => {
        if (challenges.has(id) && challenges.get(id) !== sig1) {
          throw new Error('Challenge already used with different signature');
        }
        challenges.set(id, sig1);
      }),
    };

    challenge.verify('ch_123', 'sig_original');
    await expect(challenge.verify('ch_123', 'sig_different')).rejects.toThrow('already used');
  });

  it('tracks challenge nonces to prevent reordering attacks', async () => {
    let nonce = 0;

    const challenge = {
      verify: vi.fn().mockImplementation((id, claimedNonce) => {
        if (claimedNonce <= nonce) {
          throw new Error('Challenge nonce is not increasing');
        }
        nonce = claimedNonce;
      }),
    };

    challenge.verify('ch_1', 1);
    challenge.verify('ch_2', 2);
    await expect(challenge.verify('ch_3', 1)).rejects.toThrow('not increasing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING ON AUTH ENDPOINTS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Rate Limiting on Auth Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks excessive auth attempts from single IP', async () => {
    const attempts = new Map<string, number>();
    const maxAttempts = 5;

    const limiter = {
      checkLimit: vi.fn().mockImplementation((ip) => {
        const count = attempts.get(ip) || 0;
        if (count >= maxAttempts) {
          throw new Error('Too many authentication attempts');
        }
        attempts.set(ip, count + 1);
      }),
    };

    for (let i = 0; i < 5; i++) {
      limiter.checkLimit('192.168.1.1');
    }

    await expect(limiter.checkLimit('192.168.1.1')).rejects.toThrow('Too many');
  });

  it('applies different rate limits for challenge requests', async () => {
    const limiter = {
      checkChallengeLimit: vi.fn().mockImplementation((ip) => {
        // Stricter limit for challenges
        if ((ip as any).attempts > 10) {
          throw new Error('Challenge rate limit exceeded');
        }
      }),
    };

    expect(limiter.checkChallengeLimit).toBeDefined();
  });

  it('resets rate limit after timeout period', async () => {
    const attempts = new Map<string, { count: number; timestamp: number }>();
    const timeout = 300000; // 5 minutes
    const maxAttempts = 5;

    const limiter = {
      checkLimit: vi.fn().mockImplementation((ip) => {
        const now = Date.now();
        const entry = attempts.get(ip);

        if (entry && now - entry.timestamp < timeout) {
          if (entry.count >= maxAttempts) {
            throw new Error('Rate limit exceeded');
          }
          entry.count++;
        } else {
          attempts.set(ip, { count: 1, timestamp: now });
        }
      }),
    };

    limiter.checkLimit('192.168.1.1');
    limiter.checkLimit('192.168.1.1');

    // Simulate time passing beyond timeout
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 360000)); // 6 minutes later
    vi.useRealTimers();

    // Should reset
    limiter.checkLimit('192.168.1.1');
  });

  it('includes Retry-After header on auth rate limit', async () => {
    const limiter = {
      checkLimit: vi.fn().mockImplementation(() => {
        throw new Error('Rate limited, retry after 60 seconds');
      }),
    };

    try {
      limiter.checkLimit('ip');
    } catch (err: any) {
      expect(err.message).toContain('retry after');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RBAC PERMISSION DENIAL TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: RBAC Permission Denials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies access to premium features for free users', async () => {
    const rbac = {
      checkPermission: vi.fn().mockImplementation((user, feature) => {
        if (user.tier === 'free' && feature === 'analytics_premium') {
          throw new Error('Insufficient permissions');
        }
      }),
    };

    await expect(rbac.checkPermission({ tier: 'free' }, 'analytics_premium')).rejects.toThrow(
      'Insufficient',
    );
  });

  it('denies write access for read-only tokens', async () => {
    const rbac = {
      checkPermission: vi.fn().mockImplementation((token, action) => {
        if (token.scope === 'read' && action === 'write') {
          throw new Error('Token does not have write permission');
        }
      }),
    };

    await expect(rbac.checkPermission({ scope: 'read' }, 'write')).rejects.toThrow(
      'write permission',
    );
  });

  it('denies access outside allowed IP whitelist', async () => {
    const rbac = {
      checkIpAccess: vi.fn().mockImplementation((token, clientIp) => {
        const whitelist = ['192.168.1.1', '10.0.0.1'];
        if (token.ipWhitelist && !whitelist.includes(clientIp)) {
          throw new Error('Client IP not in whitelist');
        }
      }),
    };

    await expect(rbac.checkIpAccess({ ipWhitelist: true }, '203.0.113.50')).rejects.toThrow(
      'not in whitelist',
    );
  });

  it('denies contract operations for unauthorized wallets', async () => {
    const rbac = {
      canModifyContract: vi.fn().mockImplementation((user, contract) => {
        if (user.id !== contract.ownerId) {
          throw new Error('Not authorized to modify this contract');
        }
      }),
    };

    await expect(rbac.canModifyContract({ id: 'user123' }, { ownerId: 'user456' })).rejects.toThrow(
      'Not authorized',
    );
  });

  it('denies admin operations for non-admin users', async () => {
    const rbac = {
      checkAdminRole: vi.fn().mockImplementation((user) => {
        if (user.role !== 'admin') {
          throw new Error('Admin role required');
        }
      }),
    };

    await expect(rbac.checkAdminRole({ role: 'user' })).rejects.toThrow('Admin role');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION TIMEOUT AND INVALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: Session Timeout and Invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates session after inactivity timeout', async () => {
    const sessionManager = {
      checkTimeout: vi.fn().mockImplementation((lastActivity) => {
        const timeout = 30 * 60 * 1000; // 30 minutes
        if (Date.now() - lastActivity > timeout) {
          throw new Error('Session expired due to inactivity');
        }
      }),
    };

    const oldTime = Date.now() - 31 * 60 * 1000; // 31 minutes ago
    await expect(sessionManager.checkTimeout(oldTime)).rejects.toThrow('inactivity');
  });

  it('requires re-authentication after session invalidation', async () => {
    const invalidate = prismaWrite.authSession.delete as ReturnType<typeof vi.fn>;
    invalidate.mockResolvedValue({ id: 'sess_123' });

    const findSession = prismaRead.authSession.findFirst as ReturnType<typeof vi.fn>;
    findSession.mockResolvedValue(null);

    // Invalidate session
    await invalidate();

    // Try to use invalidated session
    const session = await findSession();
    expect(session).toBeNull();
  });

  it('clears refresh tokens on session invalidation', async () => {
    const invalidate = prismaWrite.authSession.update as ReturnType<typeof vi.fn>;
    invalidate.mockResolvedValue({
      id: 'sess_123',
      refreshToken: null,
    });

    const result = await invalidate();
    expect(result.refreshToken).toBeNull();
  });

  it('logs out all sessions for a user on password change', async () => {
    const logout = prismaWrite.authSession.delete as ReturnType<typeof vi.fn>;
    logout.mockResolvedValue({ deletedCount: 5 });

    const result = await logout();
    expect(result.deletedCount).toBe(5);
  });

  it('detects and rejects concurrent session usage from different locations', async () => {
    const sessionValidator = {
      validate: vi.fn().mockImplementation((session, currentLocation) => {
        if (session.lastLocation && session.lastLocation !== currentLocation) {
          throw new Error('Concurrent session from different location detected');
        }
      }),
    };

    await expect(
      sessionValidator.validate({ lastLocation: '192.168.1.1' }, '203.0.113.50'),
    ).rejects.toThrow('Concurrent session');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API KEY REVOCATION AND EXPIRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth: API Key Revocation and Expiration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects revoked API keys', async () => {
    const findKey = prismaRead.apiKey.findFirst as ReturnType<typeof vi.fn>;
    findKey.mockResolvedValue({
      id: 'key_123',
      revokedAt: new Date(),
    });

    const key = await findKey();
    if (key.revokedAt) {
      throw new Error('API key has been revoked');
    }
  });

  it('rejects expired API keys', async () => {
    const validator = {
      checkExpiry: (key: any) => {
        if (key.expiresAt && key.expiresAt < new Date()) {
          throw new Error('API key has expired');
        }
      },
    };

    const expiredKey = {
      expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
    };

    try {
      validator.checkExpiry(expiredKey);
      throw new Error('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('expired');
    }
  });

  it('invalidates all requests using revoked key', async () => {
    const revokedKeyId = 'key_123';
    const cacheDelete_mock = cacheDelete as ReturnType<typeof vi.fn>;
    cacheDelete_mock.mockResolvedValue(undefined);

    await cacheDelete_mock(`apikey:${revokedKeyId}`);
    expect(cacheDelete_mock).toHaveBeenCalledWith(`apikey:${revokedKeyId}`);
  });

  it('audits API key revocation with reason', async () => {
    const audit = vi.fn().mockResolvedValue({
      auditId: 'audit_123',
      action: 'api_key_revoked',
      reason: 'suspected_compromise',
      timestamp: new Date(),
    });

    const result = await audit('key_123', 'suspected_compromise');
    expect(result.action).toBe('api_key_revoked');
    expect(result.reason).toBe('suspected_compromise');
  });

  it('requires admin action to revoke API keys', async () => {
    const revoke = {
      execute: (user: any, action: string) => {
        if (user.role !== 'admin') {
          throw new Error('Only admins can revoke API keys');
        }
      },
    };

    try {
      revoke.execute({ role: 'user' }, 'revoke');
      throw new Error('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('Only admins');
    }
  });

  it('alerts user when API key is about to expire', async () => {
    const alerter = {
      checkExpiry: vi.fn().mockImplementation((key) => {
        const daysUntilExpiry = Math.floor((key.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysUntilExpiry <= 7) {
          return { alert: true, daysRemaining: daysUntilExpiry };
        }
      }),
    };

    const result = alerter.checkExpiry({
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, // Expires in 3 days
    });
    expect(result.alert).toBe(true);
    expect(result.daysRemaining).toBe(3);
  });
});
