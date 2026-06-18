import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { networkRouter } from '../src/middleware/networkRouter';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    hostname: 'localhost',
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const ctx = { headers: {} as Record<string, string>, statusCode: 200, body: undefined as unknown };
  const res = {
    setHeader: (k: string, v: string) => { ctx.headers[k] = v; },
    status: (code: number) => { ctx.statusCode = code; return res; },
    json: (body: unknown) => { ctx.body = body; return res; },
  } as unknown as Response;
  return { res, ctx };
}

describe('networkRouter middleware', () => {
  const originalEnv = process.env.STELLAR_NETWORK;

  beforeEach(() => {
    process.env.STELLAR_NETWORK = 'testnet';
  });

  afterEach(() => {
    process.env.STELLAR_NETWORK = originalEnv;
  });

  it('uses X-Network header when provided', () => {
    const req = makeReq({ headers: { 'x-network': 'mainnet' } });
    const { res, ctx } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect((req as any).network).toBe('mainnet');
    expect((req as any).networkProfile.name).toBe('mainnet');
    expect(ctx.headers['X-Network']).toBe('mainnet');
    expect(next).toHaveBeenCalledOnce();
  });

  it('detects network from exact subdomain', () => {
    const req = makeReq({ hostname: 'testnet.example.com' });
    const { res, ctx } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect((req as any).network).toBe('testnet');
    expect(ctx.headers['X-Network']).toBe('testnet');
    expect(next).toHaveBeenCalledOnce();
  });

  it('detects network from prefixed subdomain (e.g. mainnet-api.example.com)', () => {
    const req = makeReq({ hostname: 'mainnet-api.example.com' });
    const { res, ctx } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect((req as any).network).toBe('mainnet');
    expect(ctx.headers['X-Network']).toBe('mainnet');
    expect(next).toHaveBeenCalledOnce();
  });

  it('falls back to STELLAR_NETWORK env var when no header or subdomain match', () => {
    process.env.STELLAR_NETWORK = 'devnet';
    const req = makeReq({ hostname: 'localhost' });
    const { res, ctx } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect((req as any).network).toBe('devnet');
    expect(ctx.headers['X-Network']).toBe('devnet');
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 400 for an unknown X-Network value', () => {
    const req = makeReq({ headers: { 'x-network': 'unknown-net' } });
    const { res, ctx } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect(ctx.statusCode).toBe(400);
    expect((ctx.body as any).error).toMatch(/unknown-net/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('X-Network header takes precedence over subdomain', () => {
    const req = makeReq({
      headers: { 'x-network': 'devnet' },
      hostname: 'mainnet-api.example.com',
    });
    const { res } = makeRes();
    const next = vi.fn();

    networkRouter(req, res, next as NextFunction);

    expect((req as any).network).toBe('devnet');
    expect(next).toHaveBeenCalledOnce();
  });
});
