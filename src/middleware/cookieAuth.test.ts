/**
 * Unit tests for session cookie authentication middleware.
 *
 * Tests cover:
 * - Cookie signing and verification
 * - Session data extraction
 * - Middleware behavior (valid/invalid/missing cookies)
 * - Authorization helpers (requireSession, requireSessionTier, etc.)
 * - Cookie setting and clearing
 */

import {
  createSessionCookie,
  sessionCookieAuth,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  requireSessionTier,
  requirePermission,
  dualAuth,
  SessionContext,
  COOKIE_CONFIG,
} from './cookieAuth';

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Session Cookie Authentication', () => {
  const testSecret = 'test-secret-key-32-chars-minimum';

  const testSession: SessionContext = {
    sessionId: 'sess_abc123',
    userId: 'user_xyz789',
    username: 'alice@example.com',
    email: 'alice@example.com',
    tier: 'pro',
    permissions: ['read', 'write'],
    createdAt: new Date('2026-07-29T00:00:00Z'),
    expiresAt: new Date('2026-07-30T00:00:00Z'),
  };

  describe('Cookie Signing and Verification', () => {
    it('should create a signed cookie', () => {
      const cookie = createSessionCookie(testSession, testSecret);
      expect(cookie).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/); // base64.base64
      expect(cookie.split('.').length).toBe(2);
    });

    it('should reject tampered cookie', () => {
      const cookie = createSessionCookie(testSession, testSecret);
      const [payload, _sig] = cookie.split('.');
      const tamperedCookie = `${payload}.tampered_signature_data`;

      const middleware = sessionCookieAuth();
      const req = { cookies: { soroban_session: tamperedCookie } } as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_INVALID' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject cookie with wrong secret', () => {
      const cookie = createSessionCookie(testSession, testSecret);

      const middleware = sessionCookieAuth();
      const req = { cookies: { soroban_session: cookie } } as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      // Verify with wrong secret
      expect(() => {
        middleware(req, res, next);
      }).not.toThrow(); // Middleware catches and returns 400

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject expired session', () => {
      const expiredSession: SessionContext = {
        ...testSession,
        expiresAt: new Date('2020-01-01T00:00:00Z'), // Past date
      };

      const cookie = createSessionCookie(expiredSession, testSecret);

      // Temporarily override COOKIE_SECRET for this test
      const originalSecret = COOKIE_CONFIG.secret;
      (COOKIE_CONFIG as any).secret = testSecret;

      try {
        const middleware = sessionCookieAuth();
        const req = { cookies: { soroban_session: cookie } } as any;
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
        const next = jest.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('expired') }),
        );
      } finally {
        (COOKIE_CONFIG as any).secret = originalSecret;
      }
    });
  });

  describe('Middleware Behavior', () => {
    it('should pass through if no cookies', () => {
      const middleware = sessionCookieAuth();
      const req = { cookies: undefined } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.session).toBeUndefined();
    });

    it('should pass through if session cookie not present', () => {
      const middleware = sessionCookieAuth();
      const req = { cookies: { other_cookie: 'value' } } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.session).toBeUndefined();
    });

    it('should attach valid session to request', () => {
      const originalSecret = COOKIE_CONFIG.secret;
      (COOKIE_CONFIG as any).secret = testSecret;

      try {
        const cookie = createSessionCookie(testSession, testSecret);
        const middleware = sessionCookieAuth();
        const req = { cookies: { soroban_session: cookie } } as any;
        const res = {} as any;
        const next = jest.fn();

        middleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.session).toBeDefined();
        expect(req.session!.userId).toBe('user_xyz789');
        expect(req.session!.tier).toBe('pro');
      } finally {
        (COOKIE_CONFIG as any).secret = originalSecret;
      }
    });

    it('should return 400 for invalid JSON in payload', () => {
      const originalSecret = COOKIE_CONFIG.secret;
      (COOKIE_CONFIG as any).secret = testSecret;

      try {
        // Create invalid payload (not valid JSON when decoded)
        const invalidPayload = Buffer.from('not-json-{invalid}').toString('base64');
        const sig = 'fake-signature';
        const cookie = `${invalidPayload}.${sig}`;

        const middleware = sessionCookieAuth();
        const req = { cookies: { soroban_session: cookie } } as any;
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
        const next = jest.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
      } finally {
        (COOKIE_CONFIG as any).secret = originalSecret;
      }
    });
  });

  describe('Authorization Helpers', () => {
    it('requireSession: passes if session present', () => {
      const req = { session: testSession } as any;
      const res = {} as any;
      const next = jest.fn();

      requireSession(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('requireSession: rejects if session missing', () => {
      const req = {} as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      requireSession(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REQUIRED' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('requireSessionTier: passes if tier sufficient', () => {
      const req = { session: { ...testSession, tier: 'pro' } } as any;
      const res = {} as any;
      const next = jest.fn();

      const middleware = requireSessionTier('developer'); // Requires developer or higher
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('requireSessionTier: rejects if tier insufficient', () => {
      const req = { session: { ...testSession, tier: 'free' } } as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      const middleware = requireSessionTier('pro'); // Requires pro
      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_INSUFFICIENT' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('requirePermission: passes if permission present', () => {
      const req = { session: { ...testSession, permissions: ['admin', 'read'] } } as any;
      const res = {} as any;
      const next = jest.fn();

      const middleware = requirePermission('admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('requirePermission: rejects if permission missing', () => {
      const req = { session: { ...testSession, permissions: ['read'] } } as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      const middleware = requirePermission('admin');
      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('dualAuth: passes if apiKey present', () => {
      const req = { apiKey: { id: 'key_123' } } as any;
      const res = {} as any;
      const next = jest.fn();

      dualAuth(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('dualAuth: passes if session present', () => {
      const req = { session: testSession } as any;
      const res = {} as any;
      const next = jest.fn();

      dualAuth(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('dualAuth: rejects if neither auth method present', () => {
      const req = {} as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      dualAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Cookie Operations', () => {
    it('setSessionCookie: sets cookie with correct options', () => {
      const res = {
        cookie: jest.fn(),
      } as any;

      setSessionCookie(res, testSession);

      expect(res.cookie).toHaveBeenCalledWith(
        COOKIE_CONFIG.name,
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          path: '/',
        }),
      );
    });

    it('clearSessionCookie: clears cookie', () => {
      const res = {
        clearCookie: jest.fn(),
      } as any;

      clearSessionCookie(res);

      expect(res.clearCookie).toHaveBeenCalledWith(COOKIE_CONFIG.name, expect.any(Object));
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing required session fields', () => {
      const originalSecret = COOKIE_CONFIG.secret;
      (COOKIE_CONFIG as any).secret = testSecret;

      try {
        const incompleteSession = { sessionId: 'sess_123' }; // Missing userId and tier
        const cookie = Buffer.from(JSON.stringify(incompleteSession)).toString('base64');
        const sig = 'fake-sig';
        const invalidCookie = `${cookie}.${sig}`;

        const middleware = sessionCookieAuth();
        const req = { cookies: { soroban_session: invalidCookie } } as any;
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
        const next = jest.fn();

        middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('required fields') }),
        );
      } finally {
        (COOKIE_CONFIG as any).secret = originalSecret;
      }
    });

    it('should handle non-string cookie value', () => {
      const middleware = sessionCookieAuth();
      const req = { cookies: { soroban_session: 123 } } as any;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
      const next = jest.fn();

      middleware(req, res, next);

      // Should be handled gracefully (either silently ignored or logged)
      // Most likely passes through without req.session
      expect(next).toHaveBeenCalled();
    });
  });
});
