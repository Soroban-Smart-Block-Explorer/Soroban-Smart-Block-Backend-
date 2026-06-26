import { describe, it, expect } from 'vitest';

// Verify that all expected route prefixes are registered under the central router.
// We import the router directly and inspect its layer stack so we don't need a
// running server or database.

vi.mock('../src/db', () => ({
  prismaRead: { $connect: vi.fn() },
  prismaWrite: { $connect: vi.fn() },
}));
vi.mock('../src/cache', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn(), cacheDelete: vi.fn() }));
vi.mock('../src/auth/middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../src/auth/keys', () => ({
  getOrCreateKeyPair: vi.fn(),
  getJwks: vi.fn(),
  rotateKeys: vi.fn(),
}));
vi.mock('../src/auth/tokens', () => ({
  issueTokens: vi.fn(),
  verifyToken: vi.fn(),
  hashToken: vi.fn(),
  generateSessionId: vi.fn(),
  REFRESH_TOKEN_TTL: 2592000,
}));
vi.mock('../src/auth/challenge', () => ({
  createChallenge: vi.fn(),
  consumeChallenge: vi.fn(),
  getChallenge: vi.fn(),
  incrementAttempts: vi.fn(),
  checkChallengeRateLimit: vi.fn(),
}));
vi.mock('../src/auth/rbac', () => ({
  getFeatures: vi.fn(),
  featureList: vi.fn(),
  hasRole: vi.fn(),
}));
vi.mock('../src/indexer/privacy-detector', () => ({ detectPrivacyTechniques: vi.fn() }));
vi.mock('../src/indexer/privacy-scorer', () => ({ computePrivacyScore: vi.fn() }));
vi.mock('../src/indexer/privacy-graph', () => ({
  findCommonInputClusters: vi.fn(),
  analyzeTiming: vi.fn(),
  analyzeAmountCorrelation: vi.fn(),
  analyzeTaint: vi.fn(),
  buildTransactionGraph: vi.fn(),
  analyzeCluster: vi.fn(),
  getEffectiveAnonymitySets: vi.fn(),
}));
vi.mock('../src/indexer/emergency-indexer', () => ({
  classifyRisk: vi.fn(),
  computeDecentralizationScore: vi.fn(),
}));
vi.mock('../src/middleware/sanitize', () => ({
  validateAddressParam: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  isValidStellarAddress: vi.fn(() => true),
  assertValidStellarAddress: vi.fn(),
  sanitizeString: vi.fn((s: unknown) => s),
  sanitizeObject: vi.fn((o: unknown) => o),
  sanitizeInputs: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveAddress: vi.fn((s: unknown) => s),
}));
vi.mock('../src/webhooks/dispatcher', () => ({ dispatch: vi.fn() }));
vi.mock('../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));

import { vi } from 'vitest';

import { router } from '../src/api/router';

function mountedPrefixes(r: { stack?: Array<{ regexp?: RegExp }> }): string[] {
  const stack = r.stack ?? [];
  return stack
    .map((layer) => {
      const src = layer.regexp?.source ?? '';
      const m = src.match(/\\\/([^\\]+)/);
      return m ? `/${m[1].replace(/\\\//g, '/')}` : null;
    })
    .filter((p): p is string => p !== null);
}

describe('Central router mounts', () => {
  const prefixes = mountedPrefixes(router as { stack?: Array<{ regexp?: RegExp }> });

  const expected = ['privacy', 'emergency', 'webhooks', 'auth'];

  for (const prefix of expected) {
    it(`mounts /${prefix}`, () => {
      expect(prefixes.some((p) => p.includes(prefix))).toBe(true);
    });
  }
});
