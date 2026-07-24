/**
 * Tests for SSRF protection including DNS rebinding and redirect bypass scenarios.
 * 
 * These tests verify protection against:
 * 1. DNS rebinding attacks (TOCTOU vulnerabilities)
 * 2. Redirect-based SSRF bypasses
 * 3. Various private/internal IP ranges
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import dns from 'dns';
import {
  assertSafeUrl,
  isBlockedIp,
  SsrfBlockedError,
  safePost,
} from './ssrf-guard';
import axios from 'axios';

// Mock dns module
vi.mock('dns', () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
    lookup: vi.fn(),
  },
}));

// Mock axios
vi.mock('axios');

describe('SSRF Guard - IP Blocking', () => {
  test('blocks loopback IPv4 addresses', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('127.0.0.255')).toBe(true);
    expect(isBlockedIp('127.255.255.255')).toBe(true);
  });

  test('blocks private IPv4 ranges', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
  });

  test('blocks AWS/GCP metadata endpoint', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  test('blocks link-local addresses', () => {
    expect(isBlockedIp('169.254.1.1')).toBe(true);
  });

  test('blocks IPv6 loopback and link-local', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd00:ec2::254')).toBe(true); // AWS IPv6 metadata
  });

  test('allows public IPv4 addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('142.250.185.46')).toBe(false);
  });

  test('allows public IPv6 addresses', () => {
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });
});

describe('SSRF Guard - DNS Rebinding Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('blocks hostname that resolves to private IP', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['10.0.0.1']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    await expect(
      assertSafeUrl('https://evil.com/webhook')
    ).rejects.toThrow(SsrfBlockedError);

    expect(mockResolve4).toHaveBeenCalledWith('evil.com');
  });

  test('blocks hostname that resolves to AWS metadata IP', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['169.254.169.254']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    await expect(
      assertSafeUrl('https://metadata.example.com')
    ).rejects.toThrow(SsrfBlockedError);
  });

  test('allows hostname that resolves to public IP', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const result = await assertSafeUrl('https://google.com/webhook');
    expect(result).toContain('8.8.8.8');
  });

  test('blocks if ANY resolved IP is private (prevents mixed-IP attacks)', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    // Attacker returns both public and private IPs, hoping we only check one
    mockResolve4.mockResolvedValue(['8.8.8.8', '10.0.0.1']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    await expect(
      assertSafeUrl('https://evil.com/webhook')
    ).rejects.toThrow(SsrfBlockedError);
  });

  test('caches DNS results to prevent rebinding attacks', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    // First call - should hit DNS
    await assertSafeUrl('https://example.com/webhook');
    expect(mockResolve4).toHaveBeenCalledTimes(1);

    // Second call within TTL - should use cache
    await assertSafeUrl('https://example.com/webhook');
    expect(mockResolve4).toHaveBeenCalledTimes(1); // Not called again

    // Third call to different hostname - should hit DNS
    await assertSafeUrl('https://other.com/webhook');
    expect(mockResolve4).toHaveBeenCalledTimes(2);
  });

  test('blocks direct IP in private range', async () => {
    await expect(
      assertSafeUrl('https://10.0.0.1/webhook')
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      assertSafeUrl('https://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(SsrfBlockedError);
  });

  test('blocks localhost and internal TLDs', async () => {
    await expect(
      assertSafeUrl('https://localhost/webhook')
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      assertSafeUrl('https://internal.local/webhook')
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      assertSafeUrl('https://api.internal/webhook')
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe('SSRF Guard - Redirect Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NETWORK_PROFILE = 'mainnet'; // Ensure HTTPS required
  });

  afterEach(() => {
    delete process.env.NETWORK_PROFILE;
  });

  test('validates redirect target and blocks private IP', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    // Initial URL resolves to public IP
    mockResolve4
      .mockResolvedValueOnce(['8.8.8.8'])
      .mockResolvedValueOnce(['10.0.0.1']); // Redirect target resolves to private IP

    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://internal.evil.com/exfiltrate' },
      data: null,
    });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    await expect(
      safePost('https://evil.com/webhook', '{}', {}, 5000)
    ).rejects.toThrow(SsrfBlockedError);

    // Should have validated both URLs
    expect(mockResolve4).toHaveBeenCalledWith('evil.com');
    expect(mockResolve4).toHaveBeenCalledWith('internal.evil.com');
  });

  test('successfully follows redirect to another public IP', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    // Both URLs resolve to public IPs
    mockResolve4
      .mockResolvedValueOnce(['8.8.8.8'])
      .mockResolvedValueOnce(['1.1.1.1']);

    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://redirect.com/final' },
        data: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    const result = await safePost('https://start.com/webhook', '{}', {}, 5000);

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ success: true });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  test('blocks redirect to AWS metadata endpoint', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValueOnce(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      data: null,
    });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    await expect(
      safePost('https://evil.com/webhook', '{}', {}, 5000)
    ).rejects.toThrow(SsrfBlockedError);
  });

  test('enforces maximum redirect limit', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    // Create infinite redirect loop
    const mockPost = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: 'https://loop.com/next' },
      data: null,
    });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    await expect(
      safePost('https://loop.com/start', '{}', {}, 5000)
    ).rejects.toThrow(/Exceeded maximum redirect limit/);

    // Should stop after MAX_REDIRECTS (5) + initial request = 6 calls
    expect(mockPost).toHaveBeenCalledTimes(6);
  });

  test('handles relative redirect URLs correctly', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: '/redirected-path' }, // Relative URL
        data: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    const result = await safePost('https://example.com/webhook', '{}', {}, 5000);

    expect(result.status).toBe(200);
    // Should have followed redirect to same domain
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  test('blocks redirect without Location header', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: {}, // Missing Location header
      data: null,
    });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    await expect(
      safePost('https://evil.com/webhook', '{}', {}, 5000)
    ).rejects.toThrow(/missing Location header/);
  });
});

describe('SSRF Guard - Protocol Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('blocks HTTP in production environment', async () => {
    process.env.NETWORK_PROFILE = 'mainnet';

    await expect(
      assertSafeUrl('http://example.com/webhook')
    ).rejects.toThrow(/Plain HTTP is not permitted/);

    delete process.env.NETWORK_PROFILE;
  });

  test('allows HTTP in dev environment', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;

    process.env.NETWORK_PROFILE = 'devnet';
    mockResolve4.mockResolvedValue(['8.8.8.8']);
    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const result = await assertSafeUrl('http://example.com/webhook');
    expect(result).toContain('8.8.8.8');

    delete process.env.NETWORK_PROFILE;
  });

  test('blocks unsupported protocols', async () => {
    await expect(
      assertSafeUrl('ftp://example.com/webhook')
    ).rejects.toThrow(/Protocol.*not allowed/);

    await expect(
      assertSafeUrl('file:///etc/passwd')
    ).rejects.toThrow(/Protocol.*not allowed/);

    await expect(
      assertSafeUrl('javascript:alert(1)')
    ).rejects.toThrow(/Protocol.*not allowed/);
  });

  test('blocks malformed URLs', async () => {
    await expect(
      assertSafeUrl('not a url')
    ).rejects.toThrow(/Malformed URL/);

    await expect(
      assertSafeUrl('://missing-protocol')
    ).rejects.toThrow(/Malformed URL/);
  });
});

describe('SSRF Guard - DNS Pinning Integration', () => {
  test('creates separate pinned client for each redirect hop', async () => {
    const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;
    const mockResolve6 = dns.resolve6 as ReturnType<typeof vi.fn>;
    const mockAxiosCreate = axios.create as ReturnType<typeof vi.fn>;

    // Simulate DNS rebinding attempt: same hostname returns different IPs
    mockResolve4
      .mockResolvedValueOnce(['8.8.8.8'])     // First check
      .mockResolvedValueOnce(['1.1.1.1']);    // Redirect target

    mockResolve6.mockRejectedValue(new Error('No AAAA records'));

    const mockPost = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://other.com/final' },
        data: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
      });

    mockAxiosCreate.mockReturnValue({
      post: mockPost,
    });

    await safePost('https://first.com/webhook', '{}', {}, 5000);

    // Should have created two separate axios clients (one per hop)
    expect(mockAxiosCreate).toHaveBeenCalledTimes(2);

    // First client should pin to 8.8.8.8
    const firstCall = mockAxiosCreate.mock.calls[0][0];
    expect(firstCall.httpAgent).toBeDefined();
    expect(firstCall.httpsAgent).toBeDefined();

    // Second client should pin to 1.1.1.1
    const secondCall = mockAxiosCreate.mock.calls[1][0];
    expect(secondCall.httpAgent).toBeDefined();
    expect(secondCall.httpsAgent).toBeDefined();
  });
});
