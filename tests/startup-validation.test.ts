/**
 * tests/startup-validation.test.ts
 *
 * Verifies that getProfile() rejects incomplete or misconfigured profiles
 * before the process starts connecting to external services.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadProfiles() {
  vi.resetModules();
  return import('../src/profiles');
}

// ── Required URL fields ───────────────────────────────────────────────────────

describe('startup validation — mainnet requires explicit URLs', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when MAINNET_DATABASE_URL is not set', async () => {
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/databaseUrl is required/);
  });

  it('throws when MAINNET_RPC_URL is not set', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/rpcUrl is required/);
  });

  it('throws when MAINNET_RPC_WS_URL is not set', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/rpcWsUrl is required/);
  });

  it('accepts mainnet when all required URLs are provided', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).not.toThrow();
  });
});

describe('startup validation — testnet requires a database URL', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when neither TESTNET_DATABASE_URL nor DATABASE_URL is set', async () => {
    vi.stubEnv('TESTNET_DATABASE_URL', '');
    vi.stubEnv('DATABASE_URL', '');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('testnet')).toThrow(/databaseUrl is required/);
  });

  it('accepts testnet when DATABASE_URL fallback is provided', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/testdb');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('testnet')).not.toThrow();
  });
});

// ── URL protocol validation ───────────────────────────────────────────────────

describe('startup validation — URL protocol checks', () => {
  afterEach(() => vi.unstubAllEnvs());

  const base = () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
  };

  it('throws when databaseUrl uses a non-postgres protocol', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'mysql://wrong-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/postgresql/);
  });

  it('throws when rpcUrl uses a non-http protocol', async () => {
    base();
    vi.stubEnv('MAINNET_RPC_URL', 'ftp://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/https?/);
  });

  it('throws when rpcWsUrl uses an http protocol instead of ws', async () => {
    base();
    vi.stubEnv('MAINNET_RPC_WS_URL', 'https://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/wss?/);
  });

  it('accepts both postgresql:// and postgres:// for databaseUrl', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgres://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).not.toThrow();
  });

  it('accepts both https:// and http:// for rpcUrl (devnet uses http)', async () => {
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('devnet')).not.toThrow();
    const p = getProfile('devnet');
    expect(p.rpcUrl).toMatch(/^http:\/\//);
  });
});

// ── Network profile consistency ───────────────────────────────────────────────

describe('startup validation — network profile consistency', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when mainnet rpcUrl contains "testnet"', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://soroban-testnet.stellar.org');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/testnet/);
  });

  it('throws when mainnet horizonUrl contains "testnet"', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_HORIZON_URL', 'https://horizon-testnet.stellar.org');
    const { getProfile } = await loadProfiles();
    expect(() => getProfile('mainnet')).toThrow(/testnet/);
  });

  it('accepts mainnet with correct production URLs', async () => {
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile } = await loadProfiles();
    const p = getProfile('mainnet');
    expect(p.name).toBe('mainnet');
  });
});

// ── validateProfile exported directly ────────────────────────────────────────

describe('startup validation — validateProfile helper', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is exported and callable directly', async () => {
    const { validateProfile, getProfile } = await loadProfiles();
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://mainnet-db/soroban');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.example.com/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.example.com/rpc');
    const { getProfile: gp } = await (async () => {
      vi.resetModules();
      return import('../src/profiles');
    })();
    const profile = gp('mainnet');
    expect(() => validateProfile(profile)).not.toThrow();
  });

  it('throws immediately on an empty databaseUrl', async () => {
    const { validateProfile } = await loadProfiles();
    const bad = {
      name: 'mainnet' as const,
      databaseUrl: '',
      rpcUrl: 'https://ok.example.com',
      rpcWsUrl: 'wss://ok.example.com',
      horizonUrl: 'https://horizon.stellar.org',
      readReplicaUrl: '',
      apiSubdomain: 'api.localhost',
      cacheUrl: 'memory://',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    };
    expect(() => validateProfile(bad)).toThrow(/databaseUrl is required/);
  });
});
