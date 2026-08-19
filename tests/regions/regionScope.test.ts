/**
 * tests/regions/regionScope.test.ts
 * Issue #556 — `?region=eu` data-sovereignty query filter middleware.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { regionScope } from '../../src/middleware/regionScope';

function mockReqRes(query: Record<string, unknown>) {
  const req = { query } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, status, json };
}

describe('regionScope middleware', () => {
  it('passes through with no restriction when region is omitted', () => {
    const { req, next } = mockReqRes({});
    regionScope(req, {} as Response, next);
    expect(req.regionScope).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets req.regionScope for a valid jurisdiction', () => {
    const { req, res, next } = mockReqRes({ region: 'eu' });
    regionScope(req, res, next);
    expect(req.regionScope).toBe('eu');
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts a region alias like ap-southeast and normalizes it to apac', () => {
    const { req, res, next } = mockReqRes({ region: 'ap-southeast' });
    regionScope(req, res, next);
    expect(req.regionScope).toBe('apac');
  });

  it('rejects an unknown region with 400 rather than silently ignoring it', () => {
    const { req, res, next, status, json } = mockReqRes({ region: 'antarctica' });
    regionScope(req, res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('antarctica') }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a non-string region value', () => {
    const { req, res, next, status } = mockReqRes({ region: ['eu', 'us'] });
    regionScope(req, res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
