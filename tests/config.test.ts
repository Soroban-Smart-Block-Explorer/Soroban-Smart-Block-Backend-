/**
 * tests/config.test.ts
 * Issue #253 — Exhaustive Configuration Testing with Schema Validation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// ── Zod schema mirroring src/config.ts shape ──────────────────────────────────
const configSchema = z.object({
  port: z.number().int().positive(),
  nodeEnv: z.string(),
  stellarNetwork: z.enum(['testnet', 'mainnet', 'devnet']),
  stellarRpcUrl: z.string(),
  horizonUrl: z.string(),
  networkPassphrase: z.string().min(1),
  databaseUrl: z.string(),
  readReplicaUrl: z.string(),
  indexerStartLedger: z.number().int().min(0),
  indexerPollIntervalMs: z.number().int().positive(),
  indexerBatchSize: z.number().int().positive(),
  indexerCatchupWorkers: z.number().int().min(1),
  rateLimitWindowMs: z.number().int().positive(),
  rateLimitMax: z.number().int().positive(),
});

// Helper: freshly load config module after env changes
async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config');
  return mod.config;
}

describe('config — defaults', () => {
  beforeEach(() => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_READ_REPLICA_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', '');
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('INDEXER_START_LEDGER', '');
    vi.stubEnv('INDEXER_POLL_INTERVAL_MS', '');
    vi.stubEnv('INDEXER_BATCH_SIZE', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('parses required schema without errors', async () => {
    const cfg = await loadConfig();
    expect(() => configSchema.parse(cfg)).not.toThrow();
  });

  it('defaults port to 3000', async () => {
    const cfg = await loadConfig();
    expect(cfg.port).toBe(3000);
  });

  it('defaults nodeEnv to development', async () => {
    const cfg = await loadConfig();
    expect(cfg.nodeEnv).toBe('development');
  });

  it('defaults indexerStartLedger to 0', async () => {
    const cfg = await loadConfig();
    expect(cfg.indexerStartLedger).toBe(0);
  });

  it('defaults indexerPollIntervalMs to 5000', async () => {
    const cfg = await loadConfig();
    expect(cfg.indexerPollIntervalMs).toBe(5000);
  });

  it('defaults indexerBatchSize to 100', async () => {
    const cfg = await loadConfig();
    expect(cfg.indexerBatchSize).toBe(100);
  });

  it('defaults rateLimitMax to 100', async () => {
    const cfg = await loadConfig();
    expect(cfg.rateLimitMax).toBe(100);
  });

  it('defaults indexerCatchupWorkers to 4', async () => {
    const cfg = await loadConfig();
    expect(cfg.indexerCatchupWorkers).toBe(4);
  });

  it('defaults microBlockPollIntervalMs to 2500', async () => {
    const cfg = await loadConfig();
    expect(cfg.microBlockPollIntervalMs).toBe(2500);
  });

  it('defaults rateLimitWindowMs to 60000', async () => {
    const cfg = await loadConfig();
    expect(cfg.rateLimitWindowMs).toBe(60000);
  });
});

describe('config — env var overrides', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads PORT from env', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', '4000');
    const cfg = await loadConfig();
    expect(cfg.port).toBe(4000);
  });

  it('reads NODE_ENV from env', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('NODE_ENV', 'production');
    const cfg = await loadConfig();
    expect(cfg.nodeEnv).toBe('production');
  });

  it('reads INDEXER_BATCH_SIZE from env', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('INDEXER_BATCH_SIZE', '50');
    const cfg = await loadConfig();
    expect(cfg.indexerBatchSize).toBe(50);
  });

  it('accepts PORT=1 (minimum valid port)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', '1');
    const cfg = await loadConfig();
    expect(cfg.port).toBe(1);
  });

  it('accepts PORT=65535 (maximum valid port)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', '65535');
    const cfg = await loadConfig();
    expect(cfg.port).toBe(65535);
  });

  it('accepts INDEXER_BATCH_SIZE=1 (minimum)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('INDEXER_BATCH_SIZE', '1');
    const cfg = await loadConfig();
    expect(cfg.indexerBatchSize).toBe(1);
  });

  it('accepts INDEXER_BATCH_SIZE=1000 (maximum)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('INDEXER_BATCH_SIZE', '1000');
    const cfg = await loadConfig();
    expect(cfg.indexerBatchSize).toBe(1000);
  });
});

describe('config — NaN / invalid numeric inputs cause startup failure', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('PORT=abc throws validation error on startup', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', 'abc');

    // The config module should throw during import
    await expect(async () => {
      vi.resetModules();
      await import('../src/config');
    }).rejects.toThrow(/Invalid value for PORT/);
  });

  it('INDEXER_BATCH_SIZE=-50 throws validation error', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('INDEXER_BATCH_SIZE', '-50');

    await expect(async () => {
      vi.resetModules();
      await import('../src/config');
    }).rejects.toThrow(/Invalid value for INDEXER_BATCH_SIZE/);
  });

  it('RATE_LIMIT_MAX=0 throws validation error', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('RATE_LIMIT_MAX', '0');

    await expect(async () => {
      vi.resetModules();
      await import('../src/config');
    }).rejects.toThrow(/Invalid value for RATE_LIMIT_MAX/);
  });

  it('INDEXER_POLL_INTERVAL_MS=50 throws validation error (too small)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('INDEXER_POLL_INTERVAL_MS', '50');

    await expect(async () => {
      vi.resetModules();
      await import('../src/config');
    }).rejects.toThrow(/Invalid value for INDEXER_POLL_INTERVAL_MS/);
  });

  it('PORT=70000 throws validation error (too large)', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('PORT', '70000');

    await expect(async () => {
      vi.resetModules();
      await import('../src/config');
    }).rejects.toThrow(/Invalid value for PORT/);
  });
});

describe('config — network profile wiring', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses testnet profile when STELLAR_NETWORK=testnet', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    const cfg = await loadConfig();
    expect(cfg.stellarNetwork).toBe('testnet');
    expect(cfg.networkPassphrase).toContain('Test SDF Network');
  });

  it('uses devnet profile when STELLAR_NETWORK=devnet', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'devnet');
    vi.stubEnv('DEVNET_DATABASE_URL', 'postgresql://localhost/devnet');
    const cfg = await loadConfig();
    expect(cfg.stellarNetwork).toBe('devnet');
    expect(cfg.networkPassphrase).toContain('Standalone Network');
  });

  it('uses mainnet profile when STELLAR_NETWORK=mainnet', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'mainnet');
    vi.stubEnv('MAINNET_DATABASE_URL', 'postgresql://localhost/mainnet');
    vi.stubEnv('MAINNET_RPC_URL', 'https://mainnet.stellar.org/rpc');
    vi.stubEnv('MAINNET_RPC_WS_URL', 'wss://mainnet.stellar.org/rpc');
    const cfg = await loadConfig();
    expect(cfg.stellarNetwork).toBe('mainnet');
    expect(cfg.networkPassphrase).toContain('Public Global Stellar Network');
  });

  it('exposes stellarRpcUrl from profile', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_RPC_URL', 'https://custom-rpc.example.com');
    const cfg = await loadConfig();
    expect(cfg.stellarRpcUrl).toBe('https://custom-rpc.example.com');
  });
});

// ── Snapshot test — detects unintended config shape changes ───────────────────
describe('config — shape snapshot', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('config has all expected top-level keys', async () => {
    vi.stubEnv('STELLAR_NETWORK', 'testnet');
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/test');
    vi.stubEnv('TESTNET_DATABASE_URL', 'postgresql://localhost/test');
    const cfg = await loadConfig();
    const keys = Object.keys(cfg).sort();
    expect(keys).toContain('port');
    expect(keys).toContain('nodeEnv');
    expect(keys).toContain('stellarNetwork');
    expect(keys).toContain('stellarRpcUrl');
    expect(keys).toContain('databaseUrl');
    expect(keys).toContain('readReplicaUrl');
    expect(keys).toContain('indexerStartLedger');
    expect(keys).toContain('indexerPollIntervalMs');
    expect(keys).toContain('indexerBatchSize');
    expect(keys).toContain('rateLimitMax');
  });
});
