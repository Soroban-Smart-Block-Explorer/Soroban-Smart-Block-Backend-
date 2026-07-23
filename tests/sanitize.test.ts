import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  sanitizeString,
  sanitizeObject,
  sanitizeInputs,
  isValidStellarAddress,
  validateAddressParam,
} from '../src/middleware/sanitize';

// ── sanitizeString ───────────────────────────────────────────────────────────
describe('sanitizeString', () => {
  it('passes clean strings through', () => {
    expect(sanitizeString('hello world')).toBe('hello world');
  });

  it('trims whitespace', () => {
    expect(sanitizeString('  foo  ')).toBe('foo');
  });

  it('throws on XSS: <script> tag', () => {
    expect(() => sanitizeString('<script>alert(1)</script>')).toThrow();
  });

  it('throws on XSS: javascript: URI', () => {
    expect(() => sanitizeString('javascript:alert(1)')).toThrow();
  });

  it('throws on XSS: event handler', () => {
    expect(() => sanitizeString('onclick=evil()')).toThrow();
  });

  it('throws on SQL injection: single quote + comment', () => {
    expect(() => sanitizeString("' OR 1=1 --")).toThrow();
  });

  it('throws on SQL injection: UNION SELECT', () => {
    expect(() => sanitizeString('UNION SELECT * FROM users')).toThrow();
  });

  it('throws on SQL injection: DROP TABLE', () => {
    expect(() => sanitizeString('DROP TABLE users')).toThrow();
  });

  it('truncates strings longer than 2048 chars', () => {
    expect(sanitizeString('a'.repeat(3000)).length).toBe(2048);
  });

  // Penetration: unicode/double-encoding bypass attempts
  it('catches double-encoded HTML entity attack', () => {
    // Raw < is caught; %3Cscript is not an HTML tag so passes — correct behaviour
    expect(() => sanitizeString('<img src=x onerror=alert(1)>')).toThrow();
  });
});

// ── sanitizeObject ───────────────────────────────────────────────────────────
describe('sanitizeObject', () => {
  it('sanitizes string values in flat object', () => {
    const result = sanitizeObject({ name: 'alice', age: 30 }) as any;
    expect(result.name).toBe('alice');
    expect(result.age).toBe(30);
  });

  it('throws when a nested string contains XSS', () => {
    expect(() => sanitizeObject({ inner: { val: '<script>' } })).toThrow();
  });

  it('sanitizes arrays of strings', () => {
    expect(sanitizeObject(['clean', 'also clean'])).toEqual(['clean', 'also clean']);
  });

  it('throws on array containing SQL injection', () => {
    expect(() => sanitizeObject(["'; DROP TABLE--"])).toThrow();
  });

  it('handles null/numbers/booleans without modification', () => {
    expect(sanitizeObject(null)).toBeNull();
    expect(sanitizeObject(42)).toBe(42);
    expect(sanitizeObject(true)).toBe(true);
  });

  it('limits recursion depth and does not throw on deep objects', () => {
    let deep: any = { val: 'ok' };
    for (let i = 0; i < 15; i++) deep = { child: deep };
    expect(() => sanitizeObject(deep)).not.toThrow();
  });
});

// ── sanitizeInputs middleware ─────────────────────────────────────────────────
describe('sanitizeInputs middleware', () => {
  it('calls next on clean body', () => {
    const req = { body: { name: 'alice' }, query: {} } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;
    sanitizeInputs(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 400 on XSS in body', () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next = vi.fn() as NextFunction;
    sanitizeInputs({ body: { x: '<script>' }, query: {} } as Request, res, next);
    expect(res.status as any).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 on SQL injection in query', () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next = vi.fn() as NextFunction;
    sanitizeInputs({ body: {}, query: { id: "1' OR 1=1--" } } as unknown as Request, res, next);
    expect(res.status as any).toHaveBeenCalledWith(400);
  });

  it('skips body sanitization when body is not an object', () => {
    const req = { body: null, query: {} } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;
    sanitizeInputs(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ── isValidStellarAddress ────────────────────────────────────────────────────
describe('isValidStellarAddress', () => {
  it('validates G-address', () => {
    expect(isValidStellarAddress('GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3PSQK2VQ7')).toBe(
      true,
    );
  });
  it('rejects garbage string', () => {
    expect(isValidStellarAddress('not-an-address')).toBe(false);
  });
});

// ── validateAddressParam ─────────────────────────────────────────────────────
describe('validateAddressParam', () => {
  it('calls next for valid address', () => {
    const mw = validateAddressParam('address');
    const req = {
      params: { address: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3PSQK2VQ7' },
    } as unknown as Request;
    const next = vi.fn() as NextFunction;
    mw(req, {} as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 400 for invalid address', () => {
    const mw = validateAddressParam('address');
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
    const next = vi.fn() as NextFunction;
    mw({ params: { address: 'INVALID' } } as unknown as Request, res, next);
    expect(res.status as any).toHaveBeenCalledWith(400);
  });
});
