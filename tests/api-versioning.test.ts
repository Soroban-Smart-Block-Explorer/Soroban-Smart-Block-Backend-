import { describe, it, expect, vi } from 'vitest';
import { versioningMiddleware, normalizeVersion, resolveVersion } from '../src/middleware/versioning';

function run(header?: string) {
  const req: any = { headers: header ? { 'accept-version': header } : {}, requestId: 'r1' };
  const res: any = { headers: {} as Record<string, string>, statusCode: 200, body: undefined };
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  const next = vi.fn();
  versioningMiddleware(req, res, next);
  return { res, next };
}

describe('versioning middleware', () => {
  it.each(['v1', '1', '1.0', '1.x'])('accepts %s and defaults', (h) => {
    const { res, next } = run(h);
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-API-Version']).toBe('v1');
    expect(res.headers['Deprecation']).toBeUndefined();
  });

  it('defaults to v1 without header', () => {
    expect(run().next).toHaveBeenCalled();
  });

  it('rejects unsupported versions with 406', () => {
    const { res, next } = run('v2');
    expect(res.statusCode).toBe(406);
    expect(next).not.toHaveBeenCalled();
  });

  it('normalizes and rejects malformed values', () => {
    expect(normalizeVersion('1.x')).toBe('v1');
    expect(normalizeVersion('abc')).toBeNull();
    expect(resolveVersion('v9')).toBeNull();
  });
});
