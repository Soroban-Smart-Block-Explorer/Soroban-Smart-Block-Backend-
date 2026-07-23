import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db', () => ({
  prismaRead: { devApiKey: { findFirst: vi.fn() } },
  prismaWrite: { devApiKey: { update: vi.fn().mockResolvedValue(null) } },
}));
vi.mock('../src/logger', () => ({ logger: { warn: vi.fn() } }));

// Access the internal via the exported middleware to indirectly test ipMatchesCidr,
// or test it directly through the whitelist enforcement path.
import type { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '../src/middleware/apiKeyAuth';
import { prismaRead } from '../src/db';

const mockFind = (prismaRead as any).devApiKey.findFirst as ReturnType<typeof vi.fn>;

const BASE_RECORD = {
  id: 'key1',
  name: 'test',
  developerId: 'dev1',
  tier: 'developer',
  rateLimitOverride: null,
  allowedEndpoints: null,
  allowedDomains: null,
  expiresAt: null,
  revokedAt: null,
};

function makeRecord(cidrs: string[]) {
  return { ...BASE_RECORD, allowedIps: cidrs };
}

// Use a unique key per call so the module-level keyCache never returns a stale hit
let _keySeq = 0;

async function checkIp(ip: string, cidrs: string[]): Promise<boolean> {
  const uniqueKey = `cidr-test-key-${++_keySeq}`;
  mockFind.mockResolvedValue(makeRecord(cidrs));
  const req = {
    headers: { 'x-api-key': uniqueKey },
    ip,
    path: '/api/test',
  } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  await apiKeyAuth(req, res, next);
  return (next as ReturnType<typeof vi.fn>).mock.calls.length > 0;
}

describe('ipMatchesCidr — prefix lengths', () => {
  it('/32 matches exact host only', async () => {
    expect(await checkIp('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(await checkIp('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });

  it('/24 matches correct subnet, rejects outside', async () => {
    expect(await checkIp('192.168.1.100', ['192.168.1.0/24'])).toBe(true);
    expect(await checkIp('192.168.2.1', ['192.168.1.0/24'])).toBe(false);
  });

  it('/16 matches two-octet subnet', async () => {
    expect(await checkIp('172.16.5.200', ['172.16.0.0/16'])).toBe(true);
    expect(await checkIp('172.17.0.1', ['172.16.0.0/16'])).toBe(false);
  });

  it('/8 matches single-octet class A', async () => {
    expect(await checkIp('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    expect(await checkIp('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('exact IP match without CIDR notation', async () => {
    expect(await checkIp('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(await checkIp('1.2.3.5', ['1.2.3.4'])).toBe(false);
  });
});

describe('ipMatchesCidr — IPv6', () => {
  it('matches IPv6 address in /48 range', async () => {
    expect(await checkIp('2001:db8:1::1', ['2001:db8:1::/48'])).toBe(true);
    expect(await checkIp('2001:db8:2::1', ['2001:db8:1::/48'])).toBe(false);
  });

  it('matches IPv6 /128 (exact host)', async () => {
    expect(await checkIp('::1', ['::1/128'])).toBe(true);
    expect(await checkIp('::2', ['::1/128'])).toBe(false);
  });

  it('IPv4-mapped IPv6 matches against IPv4 CIDR', async () => {
    // Express may expose IPv4-mapped IPv6 addresses
    expect(await checkIp('::ffff:192.168.1.5', ['192.168.1.0/24'])).toBe(true);
    expect(await checkIp('::ffff:10.0.0.1', ['192.168.1.0/24'])).toBe(false);
  });

  it('rejects malformed IP gracefully', async () => {
    expect(await checkIp('not-an-ip', ['192.168.1.0/24'])).toBe(false);
  });
});
