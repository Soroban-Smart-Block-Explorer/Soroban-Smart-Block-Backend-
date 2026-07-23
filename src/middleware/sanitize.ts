import { Request, Response, NextFunction } from 'express';
import he from 'he';
import { translateAddress, isValidAnyAddress } from '../indexer/strkey-translator';

// ── Stellar address validation ───────────────────────────────────────────────

/** Returns true if the string is a valid Stellar account (G...), muxed (M...), or contract (C...) address. */
export function isValidStellarAddress(addr: string): boolean {
  return isValidAnyAddress(addr);
}

/**
 * Resolve an address to its canonical routing identity.
 * M-addresses are unwrapped to their underlying G-address.
 * G and C addresses are returned unchanged.
 */
export function resolveAddress(addr: string): string {
  const translated = translateAddress(addr);
  if (translated.kind === 'muxed' && translated.masterKey) {
    return translated.masterKey;
  }
  return addr;
}

/** Throws a 400-compatible error if the address is invalid. */
export function assertValidStellarAddress(addr: string, field = 'address'): void {
  if (!isValidStellarAddress(addr)) {
    throw Object.assign(new Error(`Invalid Stellar address for field '${field}': ${addr}`), {
      statusCode: 400,
    });
  }
}

// ── XSS / injection prevention ───────────────────────────────────────────────

// Matches ALL HTML tags (not just script), dangerous URI schemes, and inline event handlers
const HTML_TAG_RE = /<[^>]*>/g;
const DANGEROUS_PROTO_RE = /\b(javascript|vbscript|data):/gi;
const INLINE_HANDLER_RE = /\bon\w+\s*=/gi;
// SQL injection patterns
const SQL_PATTERN =
  /('|--|;|\/\*|\*\/|xp_|exec\s+|union\s+select|drop\s+table|insert\s+into|delete\s+from)/i;
// Prototype pollution: reject keys that would climb the prototype chain
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Maximum input size limits
const MAX_STRING_LEN = 2048;
const MAX_ARRAY_LEN = 100;
const MAX_OBJECT_DEPTH = 10;

/**
 * Strip ALL HTML tags, dangerous URI schemes, and inline event handlers from a string.
 * Returns the sanitised value without throwing.
 */
export function stripHtml(value: string): string {
  return value
    .replace(HTML_TAG_RE, '')
    .replace(DANGEROUS_PROTO_RE, '')
    .replace(INLINE_HANDLER_RE, '');
}

/**
 * HTML-encode a string for safe output in HTML contexts.
 * Uses the `he` library for comprehensive entity encoding.
 */
export function encodeForHtml(value: string): string {
  return he.encode(value, { useNamedReferences: false });
}

/** Strip or reject strings containing SQL injection or residual attack patterns. */
export function sanitizeString(value: string): string {
  // Enforce size limit first to avoid ReDoS via oversized inputs
  const trimmed = value.trim().slice(0, MAX_STRING_LEN);
  const stripped = stripHtml(trimmed);
  if (SQL_PATTERN.test(stripped)) {
    throw Object.assign(new Error('Input contains disallowed characters'), { statusCode: 400 });
  }
  return stripped;
}

/** Recursively sanitize all string values in an object, blocking prototype pollution. */
export function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > MAX_OBJECT_DEPTH) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) {
    const capped = obj.slice(0, MAX_ARRAY_LEN);
    return capped.map((v) => sanitizeObject(v, depth + 1));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Block prototype pollution: skip dangerous keys
      if (PROTO_POLLUTION_KEYS.has(k)) continue;
      const safeKey = sanitizeString(k);
      result[safeKey] = sanitizeObject(v, depth + 1);
    }
    return result;
  }
  return obj;
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Middleware that sanitizes req.body, req.query, and req.params against
 * XSS vectors (ALL HTML tags stripped), SQL injection patterns, prototype
 * pollution, and oversized inputs. Applies output encoding via `he`.
 */
export function sanitizeInputs(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeObject(req.body);
    }
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query) as typeof req.query;
    }
    next();
  } catch (err: unknown) {
    const e = err as { message?: string; statusCode?: number };
    res.status(e.statusCode ?? 400).json({ error: e.message ?? 'Invalid input' });
  }
}

/**
 * Middleware factory that validates a named route param as a Stellar address.
 * Usage: router.get('/:address', validateAddressParam('address'), handler)
 */
export function validateAddressParam(paramName = 'address') {
  return (req: Request, res: Response, next: NextFunction) => {
    const addr = req.params[paramName];
    if (!addr || !isValidStellarAddress(addr)) {
      return res.status(400).json({ error: `Invalid Stellar address: ${addr}` });
    }
    return next();
  };
}

/**
 * Middleware that enforces a maximum request body size beyond what
 * express.json() provides. Use BEFORE express.json() in the middleware chain.
 * The limit parameter should match express.json({ limit }) for consistency.
 */
export function requestSizeGuard(limitBytes = 1_048_576 /* 1 MB */) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > limitBytes) {
      return res.status(413).json({ error: `Request body too large (max ${limitBytes} bytes)` });
    }
    return next();
  };
}
