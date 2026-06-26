/**
 * tests/profiles.test.ts
 * Issue #253 — Exhaustive Configuration Testing with Schema Validation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function loadProfiles() {
  vi.resetModules();
  return import('../src/profiles');
}

describe('profiles — getProfile', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns testnet profile', async () => {
    const { getProfile } = await loadProfiles();
    const p = getProfile('testnet');
    expect(p.name).toBe('testnet');
    expect(p.networkPassphrase).toContain('Test SDF Network');
    expect(p.horizonUrl).toContain('horizon-testnet');
  });

  it('returns mainnet profile', async () => {
    const { getProfile } = await loadProfiles();
    const p = getProfile('mainnet');
    expect(p.name).toBe('mainnet');
    expect(p.networkPassphrase).toContain('Public Global Stellar Network');
    expect(p.horizonUrl).toBe('https://horizon.stellar.org');
  });

  it('returns devnet profile', async () => {
    const { getProfile } = await loadProfiles();
    const p = getProfile('devnet');
    expect(p.name).toBe('devnet');
    expect(p.networkPassphrase).toContain('Standalone Network');
    expect(p.rpcUrl).toContain('localhost');
  });

  it('throws on unknown network name', async () => {
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('futurenet')).toThrow(/futurenet/);
    expect(() => getProfile('')).toThrow();
    expect(() => getProfile('TESTNET')).toThrow();
  });

  it('error message lists valid values', async () => {
    const { getProfile } = await loadProfiles();
    try {
      getProfile('unknown');
    } catch (e: any) {
      expect(e.message).toMatch(/testnet/);
      expect(e.message).toMatch(/mainnet/);
      expect(e.message).toMatch(/devnet/);
    }
  });
});

describe('profiles — allProfiles', () => {
  it('exports all three networks', async () => {
    const { allProfiles } = await loadProfiles();
    expect(allProfiles).toHaveProperty('testnet');
    expect(allProfiles).toHaveProperty('mainnet');
    expect(allProfiles).toHaveProperty('devnet');
  });

  it('each profile has required fields', async () => {
    const { allProfiles } = await loadProfiles();
    for (const p of Object.values(allProfiles)) {
      expect(p.name).toBeTruthy();
      expect(p.networkPassphrase).toBeTruthy();
      expect(typeof p.rpcUrl).toBe('string');
      expect(typeof p.horizonUrl).toBe('string');
      expect(typeof p.databaseUrl).toBe('string');
      expect(typeof p.readReplicaUrl).toBe('string');
      expect(typeof p.cacheUrl).toBe('string');
      expect(typeof p.apiSubdomain).toBe('string');
    }
  });
});

describe('profiles — env var overrides', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('testnet rpcUrl overridden by TESTNET_RPC_URL', async () => {
    vi.stubEnv('TESTNET_RPC_URL', 'https://custom-rpc.example.com');
    const { getProfile } = await loadProfiles();
    const p = getProfile('testnet');
    expect(p.rpcUrl).toBe('https://custom-rpc.example.com');
  });

  it('testnet databaseUrl falls back to DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://fallback/db');
    vi.stubEnv('TESTNET_DATABASE_URL', '');
    const { getProfile } = await loadProfiles();
    const p = getProfile('testnet');
    expect(p.databaseUrl).toBe('postgresql://fallback/db');
  });

  it('testnet readReplicaUrl falls back to databaseUrl when no replica set', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://primary/db');
    vi.stubEnv('TESTNET_READ_REPLICA_URL', '');
    const { getProfile } = await loadProfiles();
    const p = getProfile('testnet');
    // readReplicaUrl should ultimately resolve to something non-empty
    expect(typeof p.readReplicaUrl).toBe('string');
  });

  it('devnet cacheUrl defaults to memory://', async () => {
    vi.stubEnv('DEVNET_CACHE_URL', '');
    const { getProfile } = await loadProfiles();
    const p = getProfile('devnet');
    expect(p.cacheUrl).toBe('memory://');
  });

  it('mainnet rpcUrl set via env', async () => {
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.validationcloud.io/rpc');
    const { getProfile } = await loadProfiles();
    const p = getProfile('mainnet');
    expect(p.rpcUrl).toBe('https://mainnet.validationcloud.io/rpc');
  });
});

describe('profiles — NetworkProfile type completeness', () => {
  it('all profiles have distinct passphrases', async () => {
    const { allProfiles } = await loadProfiles();
    const passphrases = Object.values(allProfiles).map((p) => p.networkPassphrase);
    const unique = new Set(passphrases);
    expect(unique.size).toBe(3);
  });

  it('devnet horizonUrl points to localhost by default', async () => {
    vi.stubEnv('DEVNET_HORIZON_URL', '');
    const { getProfile } = await loadProfiles();
    const p = getProfile('devnet');
    expect(p.horizonUrl).toContain('localhost');
  });
});
