/**
 * Session Cookie Authentication Middleware
 *
 * Provides complementary authentication to the existing X-Api-Key header auth.
 * Validates signed session cookies and extracts session data for downstream usage.
 *
 * Features:
 * - HTTP-only cookie storage (immune to XSS)
 * - Optional signed cookies (HMAC verification)
 * - Session metadata extraction (userId, tier, permissions)
 * - Graceful fallback to unauthenticated if cookie invalid/missing
 * - Audit logging for security events
 *
 * Cookie validation flow:
 * 1. Cookie parser middleware (cookieParser) unpacks cookies from Set-Cookie header
 * 2. This middleware validates signed cookies if COOKIE_SECRET is set
 * 3. Session data is extracted and attached to req.session
 * 4. Downstream code can require session auth via requireSession()
 *
 * Requires: npm install cookie-parser
 * Environment: COOKIE_SECRET (optional), COOKIE_EXPIRES_MS (optional)
 */

import * as crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

/**
 * Thrown when session cookie validation fails.
 * Unlike invalid API keys (401), this indicates the cookie structure
 * is corrupt or tampered with (should be rare in normal operation).
 */
export class SessionCookieError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SessionCookieError';
  }
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  username?: string;
  email?: string;
  tier: string;
  permissions?: string[];
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Cookie configuration from environment.
 * COOKIE_SECRET: Used for HMAC signing/verification. If empty, cookies are not validated.
 * COOKIE_EXPIRES_MS: Session duration in milliseconds (default: 24 hours)
 * COOKIE_SECURE: Only set cookie over HTTPS (default: true in production)
 * COOKIE_HTTP_ONLY: Cookie inaccessible to JavaScript (default: true)
 * COOKIE_SAME_SITE: SameSite policy (default: strict)
 * COOKIE_NAME: Session cookie name (default: soroban_session)
 */
export const COOKIE_CONFIG = {
  secret: process.env.COOKIE_SECRET ?? '',
  expiresMs: parseInt(process.env.COOKIE_EXPIRES_MS ?? String(24 * 60 * 60 * 1000), 10),
  secure: process.env.COOKIE_SECURE !== 'false',
  httpOnly: process.env.COOKIE_HTTP_ONLY !== 'false',
  sameSite: (process.env.COOKIE_SAME_SITE ?? 'strict') as 'strict' | 'lax' | 'none',
  name: process.env.COOKIE_NAME ?? 'soroban_session',
};

/**
 * Signs a session cookie value using HMAC-SHA256.
 * Returns base64-encoded "payload.signature" format.
 *
 * @param payload JSON stringified session data
 * @param secret HMAC signing secret
 * @returns Signed cookie value (payload.signature)
 */
function signCookie(payload: string, secret: string): string {
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return `${payload}.${signature}`;
}

/**
 * Verifies a signed session cookie.
 * Checks HMAC signature and returns the decoded JSON payload.
 *
 * @param value Cookie value in format "payload.signature"
 * @param secret HMAC signing secret
 * @returns Decoded JSON payload, or throws SessionCookieError if invalid
 */
function verifyCookie(value: string, secret: string): Record<string, unknown> {
  const parts = value.split('.');
  if (parts.length !== 2) {
    throw new SessionCookieError('Invalid cookie format: expected "payload.signature"');
  }

  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new SessionCookieError('Cookie signature verification failed');
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded;
  } catch {
    throw new SessionCookieError('Cookie payload is not valid JSON');
  }
}

/**
 * Creates a signed session cookie value.
 *
 * @param session Session data to encode
 * @param secret HMAC signing secret
 * @returns Signed cookie value ready to set on response
 */
export function createSessionCookie(session: SessionContext, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64');
  return signCookie(payload, secret);
}

/**
 * Parses and validates session cookie from request.
 * Returns null if no cookie, or SessionContext if valid.
 * Throws SessionCookieError if cookie present but invalid/tampered.
 *
 * @param cookies Parsed cookies object (from cookie-parser)
 * @param cookieName Cookie name to look for
 * @param secret HMAC secret for verification (optional)
 * @returns SessionContext or null
 */
function parseSessionCookie(
  cookies: Record<string, string>,
  cookieName: string,
  secret?: string,
): SessionContext | null {
  const cookieValue = cookies[cookieName];
  if (!cookieValue) return null;

  if (secret) {
    // Validate signature if secret is configured
    const decoded = verifyCookie(cookieValue, secret);

    // Validate required fields
    if (!decoded.sessionId || !decoded.userId || !decoded.tier) {
      throw new SessionCookieError('Session cookie missing required fields');
    }

    // Validate timestamps
    const expiresAt = new Date(decoded.expiresAt as string);
    if (isNaN(expiresAt.getTime())) {
      throw new SessionCookieError('Session cookie has invalid expiresAt timestamp');
    }

    if (expiresAt < new Date()) {
      throw new SessionCookieError('Session cookie has expired');
    }

    return {
      sessionId: decoded.sessionId as string,
      userId: decoded.userId as string,
      username: decoded.username as string | undefined,
      email: decoded.email as string | undefined,
      tier: decoded.tier as string,
      permissions: Array.isArray(decoded.permissions)
        ? (decoded.permissions as string[])
        : undefined,
      createdAt: new Date(decoded.createdAt as string),
      expiresAt,
    };
  } else {
    // If no secret, cookies are not verified (insecure, dev-only)
    try {
      const decoded = JSON.parse(Buffer.from(cookieValue, 'base64').toString('utf8'));
      return decoded as SessionContext;
    } catch {
      // Silently ignore invalid unsigned cookies (permissive mode)
      return null;
    }
  }
}

/**
 * CSRF Protection Configuration & Constants
 */
export const CSRF_COOKIE_NAME = 'soroban_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function generateCsrfToken(sessionId: string): string {
  const secret = COOKIE_CONFIG.secret || 'default-csrf-secret';
  return crypto.createHmac('sha256', secret).update(`${sessionId}:csrf`).digest('hex');
}

/**
 * CSRF Protection Middleware for cookie-authenticated state-changing routes.
 *
 * Safe HTTP methods (GET, HEAD, OPTIONS) are allowed through.
 * State-changing mutations (POST, PUT, PATCH, DELETE) authenticated via cookie session
 * must present a matching CSRF token in header (x-csrf-token / x-xsrf-token) or body (_csrf)
 * matching either the double-submit CSRF cookie or the session CSRF token.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(req.method)) return next();

  // If request is authenticated using session cookie
  if (req.session) {
    const headerToken =
      (req.headers['x-csrf-token'] as string) ||
      (req.headers['x-xsrf-token'] as string) ||
      (req.body && req.body._csrf);

    const cookieToken = req.cookies ? req.cookies[CSRF_COOKIE_NAME] : undefined;
    const expectedToken = generateCsrfToken(req.session.sessionId);

    let isValid = false;
    if (headerToken) {
      const headerBuf = Buffer.from(headerToken);
      if (cookieToken && cookieToken.length === headerToken.length) {
        isValid = crypto.timingSafeEqual(headerBuf, Buffer.from(cookieToken));
      }
      if (!isValid && expectedToken.length === headerToken.length) {
        isValid = crypto.timingSafeEqual(headerBuf, Buffer.from(expectedToken));
      }
    }

    if (!isValid) {
      logger.warn('[csrf] CSRF token verification failed', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      res.status(403).json({
        error: 'CSRF Token Missing or Invalid',
        message: 'Cross-site request forgery protection triggered',
        code: 'CSRF_INVALID',
      });
      return;
    }
  }

  next();
}

/**
 * Session cookie authentication middleware.
 * Validates incoming session cookies and attaches SessionContext to req.session.
 *
 * Usage:
 *   app.use(cookieParser()); // Provided by cookie-parser npm module
 *   app.use(sessionCookieAuth());
 *
 * If cookie-parser is not configured, this middleware gracefully does nothing.
 * If cookie is present but invalid/tampered, logs warning and rejects with 400.
 */
export function sessionCookieAuth(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Early exit if no cookies (cookie-parser not mounted, or no Cookie header)
    if (!req.cookies) {
      return next();
    }

    try {
      const session = parseSessionCookie(
        req.cookies,
        COOKIE_CONFIG.name,
        COOKIE_CONFIG.secret || undefined,
      );

      if (session) {
        req.session = session;
        logger.debug('[session-auth] Valid session cookie', {
          sessionId: session.sessionId,
          userId: session.userId,
          tier: session.tier,
        });
      }
    } catch (err) {
      // Cookie present but invalid/tampered
      if (err instanceof SessionCookieError) {
        logger.warn('[session-auth] Invalid session cookie', {
          error: err.message,
          ip: req.ip,
        });
        return res.status(400).json({
          error: 'Invalid Session',
          message: err.message,
          code: 'SESSION_INVALID',
        });
      }
      // Unexpected error — propagate to error handler
      return next(err);
    }

    csrfProtection(req, res, next);
  };
}

/**
 * Sets a session cookie on the response.
 * Automatically signs the cookie if COOKIE_SECRET is configured.
 * Also issues non-HttpOnly soroban_csrf cookie for double-submit verification.
 *
 * Usage:
 *   setSessionCookie(res, sessionData);
 *
 * @param res Express Response object
 * @param session Session data to encode and set
 */
export function setSessionCookie(res: Response, session: SessionContext): void {
  const value = COOKIE_CONFIG.secret
    ? createSessionCookie(session, COOKIE_CONFIG.secret)
    : Buffer.from(JSON.stringify(session)).toString('base64');

  res.cookie(COOKIE_CONFIG.name, value, {
    httpOnly: COOKIE_CONFIG.httpOnly,
    secure: COOKIE_CONFIG.secure,
    sameSite: COOKIE_CONFIG.sameSite,
    maxAge: COOKIE_CONFIG.expiresMs,
    path: '/',
  });

  const csrfToken = generateCsrfToken(session.sessionId);
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: COOKIE_CONFIG.secure,
    sameSite: COOKIE_CONFIG.sameSite,
    maxAge: COOKIE_CONFIG.expiresMs,
    path: '/',
  });
}

/**
 * Clears the session cookie from the response.
 * Used on logout.
 *
 * @param res Express Response object
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_CONFIG.name, { path: '/', httpOnly: COOKIE_CONFIG.httpOnly });
  res.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
}

/**
 * Requires a valid session cookie.
 * Returns 401 if session is not present.
 * Use after sessionCookieAuth() middleware.
 *
 * Usage:
 *   router.get('/protected', requireSession, handler);
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({
      error: 'Session Required',
      message: 'No valid session cookie found',
      code: 'SESSION_REQUIRED',
    });
    return;
  }
  next();
}

/**
 * Requires a specific session tier or higher.
 * Tiers are ordered: free < developer < pro < enterprise
 *
 * Usage:
 *   router.get('/premium', requireSessionTier('pro'), handler);
 */
export function requireSessionTier(minTier: string) {
  const tierOrder = ['free', 'developer', 'pro', 'enterprise'];
  const minIndex = tierOrder.indexOf(minTier);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session) {
      res.status(401).json({
        error: 'Session Required',
        message: 'No valid session cookie found',
        code: 'SESSION_REQUIRED',
      });
      return;
    }

    const currentIndex = tierOrder.indexOf(req.session.tier);
    if (currentIndex < minIndex) {
      res.status(403).json({
        error: 'Insufficient Tier',
        message: `Requires ${minTier} tier or higher (current: ${req.session.tier})`,
        code: 'TIER_INSUFFICIENT',
      });
      return;
    }

    next();
  };
}

/**
 * Requires a specific permission in the session.
 *
 * Usage:
 *   router.post('/admin', requirePermission('admin'), handler);
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session) {
      res.status(401).json({
        error: 'Session Required',
        message: 'No valid session cookie found',
        code: 'SESSION_REQUIRED',
      });
      return;
    }

    if (!req.session.permissions || !req.session.permissions.includes(permission)) {
      res.status(403).json({
        error: 'Permission Denied',
        message: `Requires '${permission}' permission`,
        code: 'PERMISSION_DENIED',
      });
      return;
    }

    next();
  };
}

/**
 * Combined auth: accepts either API key OR session cookie.
 * Used for endpoints that support both authentication methods.
 *
 * Usage:
 *   app.use(apiKeyAuth); // Existing header auth
 *   app.use(sessionCookieAuth()); // New cookie auth
 *   router.get('/dual-auth', dualAuth, handler); // Accepts either
 */
export function dualAuth(req: Request, res: Response, next: NextFunction): void {
  const hasApiKey = req.apiKey !== undefined;
  const hasSession = req.session !== undefined;

  if (!hasApiKey && !hasSession) {
    res.status(401).json({
      error: 'Authentication Required',
      message: 'Provide either X-Api-Key header or valid session cookie',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  next();
}
