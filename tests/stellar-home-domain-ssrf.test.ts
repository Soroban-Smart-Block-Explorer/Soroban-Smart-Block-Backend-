import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'dns';
import axios from 'axios';
import { fetchStellarToml, verifyHomeDomain } from '../src/stellar/horizon-client';

// Mock dns module
vi.mock('dns', () => {
  const resolve4 = vi.fn();
  const resolve6 = vi.fn();
  const lookup = vi.fn();
  const promises = { resolve4, resolve6, lookup };
  return {
    default: {
      resolve4,
      resolve6,
      lookup,
      promises,
    },
    promises,
    resolve4,
    resolve6,
    lookup,
  };
});

// Mock axios
vi.mock('axios');

describe('Stellar Home Domain SSRF Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NETWORK_PROFILE = 'mainnet';
  });

  afterEach(() => {
    delete process.env.NETWORK_PROFILE;
  });

  test('rejects localhost and 127.0.0.1', async () => {
    const resLocalhost = await fetchStellarToml('localhost');
    expect(resLocalhost).toBeNull();

    const resLoopbackIp = await fetchStellarToml('127.0.0.1');
    expect(resLoopbackIp).toBeNull();
  });

  test('rejects private IPv4 ranges (10.x, 172.16.x, 192.168.x)', async () => {
    expect(await fetchStellarToml('10.0.0.1')).toBeNull();
    expect(await fetchStellarToml('172.16.0.1')).toBeNull();
    expect(await fetchStellarToml('192.168.1.100')).toBeNull();
  });

  test('rejects cloud metadata IP ranges (169.254.169.254 and IPv6 metadata)', async () => {
    expect(await fetchStellarToml('169.254.169.254')).toBeNull();
    expect(await fetchStellarToml('[fd00:ec2::254]')).toBeNull();
  });

  test('rejects domains resolving to private or metadata IPs via DNS', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['10.0.0.5']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const res = await fetchStellarToml('evil-internal.com');
    expect(res).toBeNull();
    expect(mockResolve4).toHaveBeenCalledWith('evil-internal.com');
  });

  test('rejects domains resolving to cloud metadata IP via DNS', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['169.254.169.254']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const res = await fetchStellarToml('metadata-exploit.com');
    expect(res).toBeNull();
  });

  test('revalidates DNS on redirects and blocks redirect to private IP', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    // Hop 0: public domain -> 8.8.8.8
    // Hop 1: redirect domain -> 10.0.0.1 (private)
    mockResolve4.mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['10.0.0.1']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockGet = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://internal.evil.com/stellar.toml' },
      data: null,
    });

    mockAxiosCreate.mockReturnValue({ get: mockGet });

    const res = await fetchStellarToml('redirect-ssrf.com');
    expect(res).toBeNull();
    expect(mockResolve4).toHaveBeenCalledWith('redirect-ssrf.com');
    expect(mockResolve4).toHaveBeenCalledWith('internal.evil.com');
  });

  test('revalidates DNS on redirects and blocks redirect to AWS metadata', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValueOnce(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockGet = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: null,
    });

    mockAxiosCreate.mockReturnValue({ get: mockGet });

    const res = await fetchStellarToml('metadata-redirect.com');
    expect(res).toBeNull();
  });

  test('successfully fetches and parses stellar.toml for safe domain', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockGet = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: `
VERSION="2.0.0"
ACCOUNTS=["GABC1234567890"]
ORG_NAME="Stellar Safe Anchor"
      `,
    });

    mockAxiosCreate.mockReturnValue({ get: mockGet });

    const res = await fetchStellarToml('example.com');
    expect(res).toBeDefined();
    expect(res?.ORG_NAME).toBe('Stellar Safe Anchor');
    expect(res?.VERSION).toBe('2.0.0');
  });

  test('verifyHomeDomain returns false for malicious SSRF domain', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    mockResolve4.mockResolvedValue(['127.0.0.1']);

    const verified = await verifyHomeDomain('GABC1234567890', '127.0.0.1');
    expect(verified).toBe(false);
  });

  test('verifyHomeDomain verifies matching account for valid domain', async () => {
    const mockResolve4 = (dns.promises?.resolve4 ?? dns.resolve4) as ReturnType<typeof vi.fn>;
    const mockResolve6 = (dns.promises?.resolve6 ?? dns.resolve6) as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockGet = vi.fn().mockResolvedValueOnce({
      status: 200,
      data: `
ACCOUNTS="GABC1234567890, GDEF0987654321"
ORG_NAME="Verified Anchor"
      `,
    });

    mockAxiosCreate.mockReturnValue({ get: mockGet });

    const verified = await verifyHomeDomain('GABC1234567890', 'example.com');
    expect(verified).toBe(true);
  });
});
