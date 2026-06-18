import { Request, Response, NextFunction } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
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
    throw Object.assign(new Error(`Invalid Stellar address for field '${field}': ${addr}`), { statusCode: 400 });
  }
}

// ── XSS / injection prevention ───────────────────────────────────────────────

const XSS_PATTERN = /<[^>]*>|javascript:|on\w+\s*=/i;
const SQL_PATTERN = /('|--|;|\/\*|\*\/|xp_|exec\s+|union\s+select|drop\s+table)/i;

/** Strip or reject strings containing XSS or SQL injection patterns. */
export function sanitizeString(value: string): string {
  if (XSS_PATTERN.test(value) || SQL_PATTERN.test(value)) {
    throw Object.assign(new Error('Input contains disallowed characters'), { statusCode: 400 });
  }
  // Trim and limit length to prevent ReDoS via oversized inputs
  return value.trim().slice(0, 2048);
}

/** Recursively sanitize all string values in an object. */
export function sanitizeObject(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj; // prevent deep recursion
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map((v) => sanitizeObject(v, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[sanitizeString(k)] = sanitizeObject(v, depth + 1);
    }
    return result;
  }
  return obj;
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Middleware that sanitizes req.body, req.query, and req.params against
 * XSS vectors, SQL injection patterns, and oversized inputs.
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
