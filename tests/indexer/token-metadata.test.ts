/**
 * Tests for the token metadata micro-service.
 *
 * Covers:
 *  - Resolution order: cache → DB Contract → DB SacMapping → RPC → null
 *  - formatTokenAmount: correct decimal application and symbol appending
 *  - formatTokenAmountSync: cache-only path
 *  - invalidateTokenMetadata / clearTokenMetadataCache
 *  - warmTokenMetadataCache: pre-populates from DB
 *  - getClassicAssetMetadata: Horizon path
 *  - getTokenMetadataCacheSize
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn(), findMany: vi.fn() },
    sacMapping: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  prismaWrite: {},
  get prisma() {
    return (this as any).prismaWrite;
  },
}));

// ─── Mock axios (Horizon calls) ───────────────────────────────────────────────

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

// ─── Mock config ──────────────────────────────────────────────────────────────

vi.mock('../../src/config', () => ({
  config: {
    stellarRpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    nodeEnv: 'test',
  },
}));

// ─── Mock SorobanRpc (RPC simulation) ────────────────────────────────────────

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: vi.fn().mockResolvedValue({ error: 'not a token' }),
      })),
      Api: {
        isSimulationError: vi.fn().mockReturnValue(true),
      },
    },
  };
});

import { prismaRead } from '../../src/db';
import axios from 'axios';
import {
  getTokenMetadata,
  getClassicAssetMetadata,
  formatTokenAmount,
  formatTokenAmountSync,
  invalidateTokenMetadata,
  clearTokenMetadataCache,
  warmTokenMetadataCache,
  getTokenMetadataCacheSize,
} from '../../src/indexer/token-metadata';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOROBAN_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const SAC_ADDR = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenMetadataCache();
});

// ─── getTokenMetadata — DB Contract path ─────────────────────────────────────

describe('getTokenMetadata — DB Contract', () => {
  it('returns metadata from DB when isToken=true', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue(null);

    const meta = await getTokenMetadata(SOROBAN_ADDR);
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe('USDC');
    expect(meta!.name).toBe('USD Coin');
    expect(meta!.decimals).toBe(6);
    expect(meta!.source).toBe('db');
  });

  it('defaults decimals to 7 when tokenDecimals is null', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'XLM',
      tokenName: null,
      tokenDecimals: null,
    } as any);

    const meta = await getTokenMetadata(SOROBAN_ADDR);
    expect(meta!.decimals).toBe(7);
  });

  it('caches the result — second call does not hit DB', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    await getTokenMetadata(SOROBAN_ADDR);
    await getTokenMetadata(SOROBAN_ADDR);

    expect(prismaRead.contract.findUnique).toHaveBeenCalledTimes(1);
  });
});

// ─── getTokenMetadata — SacMapping path ──────────────────────────────────────

describe('getTokenMetadata — SacMapping (classic asset)', () => {
  beforeEach(() => {
    // Contract table returns non-token
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: false,
      tokenSymbol: null,
      tokenName: null,
      tokenDecimals: null,
    } as any);
  });

  it('resolves from SacMapping with Horizon name', async () => {
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue({
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    } as any);
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        _embedded: {
          records: [{ asset_code: 'USDC', asset_issuer: 'GA5Z...', name: 'USD Coin' }],
        },
      },
    });

    const meta = await getTokenMetadata(SAC_ADDR);
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe('USDC');
    expect(meta!.name).toBe('USD Coin');
    expect(meta!.decimals).toBe(7);
    expect(meta!.source).toBe('sac');
  });

  it('falls back to assetCode as name when Horizon returns no record', async () => {
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue({
      assetCode: 'MYTOKEN',
      assetIssuer: 'GISSUER',
    } as any);
    vi.mocked(axios.get).mockResolvedValue({
      data: { _embedded: { records: [] } },
    });

    const meta = await getTokenMetadata(SAC_ADDR);
    expect(meta!.name).toBe('MYTOKEN');
    expect(meta!.symbol).toBe('MYTOKEN');
  });

  it('handles native XLM (null issuer) without Horizon call', async () => {
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue({
      assetCode: 'XLM',
      assetIssuer: null,
    } as any);

    const meta = await getTokenMetadata(SAC_ADDR);
    expect(meta!.symbol).toBe('XLM');
    expect(meta!.name).toBe('Stellar Lumens');
    // Horizon should NOT be called for native XLM
    expect(axios.get).not.toHaveBeenCalled();
  });
});

// ─── getTokenMetadata — RPC simulation path ───────────────────────────────────

describe('getTokenMetadata — RPC simulation', () => {
  beforeEach(() => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: false,
      tokenSymbol: null,
      tokenName: null,
      tokenDecimals: null,
    } as any);
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue(null);
  });

  it('returns null when RPC simulation fails (not a token)', async () => {
    // Default mock returns simulation error → null
    const meta = await getTokenMetadata(SOROBAN_ADDR);
    expect(meta).toBeNull();
  });
});

// ─── getTokenMetadata — null path ────────────────────────────────────────────

describe('getTokenMetadata — not found', () => {
  it('returns null when contract is not a token and no SAC mapping exists', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: false,
      tokenSymbol: null,
      tokenName: null,
      tokenDecimals: null,
    } as any);
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue(null);

    const meta = await getTokenMetadata(SOROBAN_ADDR);
    expect(meta).toBeNull();
  });
});

// ─── invalidateTokenMetadata ──────────────────────────────────────────────────

describe('invalidateTokenMetadata', () => {
  it('evicts the entry so the next call re-fetches from DB', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    await getTokenMetadata(SOROBAN_ADDR);
    expect(prismaRead.contract.findUnique).toHaveBeenCalledTimes(1);

    invalidateTokenMetadata(SOROBAN_ADDR);

    await getTokenMetadata(SOROBAN_ADDR);
    expect(prismaRead.contract.findUnique).toHaveBeenCalledTimes(2);
  });
});

// ─── formatTokenAmount ────────────────────────────────────────────────────────

describe('formatTokenAmount', () => {
  it('formats with 6 decimals and appends symbol (USDC example)', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    const result = await formatTokenAmount(10_000_000n, SOROBAN_ADDR);
    expect(result).toBe('10.000000 USDC');
  });

  it('formats with 7 decimals (Stellar default)', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'XLM',
      tokenName: 'Stellar Lumens',
      tokenDecimals: 7,
    } as any);

    const result = await formatTokenAmount(10_000_000n, SOROBAN_ADDR);
    expect(result).toBe('1.0000000 XLM');
  });

  it('formats with 2 decimals', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USD',
      tokenName: 'US Dollar',
      tokenDecimals: 2,
    } as any);

    const result = await formatTokenAmount(1050n, SOROBAN_ADDR);
    expect(result).toBe('10.50 USD');
  });

  it('uses fallback decimals when metadata is unavailable', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: false,
      tokenSymbol: null,
      tokenName: null,
      tokenDecimals: null,
    } as any);
    vi.mocked(prismaRead.sacMapping.findUnique).mockResolvedValue(null);

    const result = await formatTokenAmount(10_000_000n, SOROBAN_ADDR, {
      fallbackDecimals: 6,
      fallbackSymbol: 'UNKNOWN',
    });
    expect(result).toBe('10.000000 UNKNOWN');
  });

  it('omits symbol when none is available', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: null,
      tokenName: null,
      tokenDecimals: 7,
    } as any);

    const result = await formatTokenAmount(10_000_000n, SOROBAN_ADDR);
    expect(result).toBe('1.0000000');
  });

  it('accepts a number input (not just bigint)', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    const result = await formatTokenAmount(10_000_000, SOROBAN_ADDR);
    expect(result).toBe('10.000000 USDC');
  });

  it('handles zero correctly', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    const result = await formatTokenAmount(0n, SOROBAN_ADDR);
    expect(result).toBe('0.000000 USDC');
  });

  it('handles large amounts without precision loss', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    // 1 billion USDC = 1_000_000_000_000_000 raw (15 digits)
    const result = await formatTokenAmount(1_000_000_000_000_000n, SOROBAN_ADDR);
    expect(result).toBe('1000000000.000000 USDC');
  });
});

// ─── formatTokenAmountSync ────────────────────────────────────────────────────

describe('formatTokenAmountSync', () => {
  it('returns formatted string from cache', async () => {
    // Populate cache first
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);
    await getTokenMetadata(SOROBAN_ADDR);

    const result = formatTokenAmountSync(10_000_000n, SOROBAN_ADDR);
    expect(result).toBe('10.000000 USDC');
  });

  it('uses fallback when address is not cached', () => {
    const result = formatTokenAmountSync(10_000_000n, 'UNKNOWN_ADDR', 7, 'XLM');
    expect(result).toBe('1.0000000 XLM');
  });

  it('omits symbol when fallback is empty string', () => {
    const result = formatTokenAmountSync(10_000_000n, 'UNKNOWN_ADDR', 7);
    expect(result).toBe('1.0000000');
  });
});

// ─── getClassicAssetMetadata ──────────────────────────────────────────────────

describe('getClassicAssetMetadata', () => {
  it('returns metadata for a classic asset with issuer', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        _embedded: {
          records: [{ asset_code: 'USDC', asset_issuer: 'GA5Z...', name: 'USD Coin' }],
        },
      },
    });

    const meta = await getClassicAssetMetadata(
      'USDC',
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    );
    expect(meta.symbol).toBe('USDC');
    expect(meta.name).toBe('USD Coin');
    expect(meta.decimals).toBe(7);
    expect(meta.source).toBe('classic');
  });

  it('returns XLM metadata without Horizon call', async () => {
    const meta = await getClassicAssetMetadata('XLM', null);
    expect(meta.symbol).toBe('XLM');
    expect(meta.name).toBe('Stellar Lumens');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('caches the result on second call', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { _embedded: { records: [{ asset_code: 'USDC', name: 'USD Coin' }] } },
    });

    await getClassicAssetMetadata('USDC', 'GA5Z...');
    await getClassicAssetMetadata('USDC', 'GA5Z...');

    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

// ─── warmTokenMetadataCache ───────────────────────────────────────────────────

describe('warmTokenMetadataCache', () => {
  it('pre-populates cache from DB tokens and SAC mappings', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: SOROBAN_ADDR, tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimals: 6 },
    ] as any);
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: SAC_ADDR, assetCode: 'XLM', assetIssuer: null },
    ] as any);

    await warmTokenMetadataCache();

    expect(getTokenMetadataCacheSize()).toBe(2);

    // Subsequent getTokenMetadata calls should NOT hit DB
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue(null as any);
    const meta = await getTokenMetadata(SOROBAN_ADDR);
    expect(meta).not.toBeNull();
    expect(meta!.symbol).toBe('USDC');
    expect(prismaRead.contract.findUnique).not.toHaveBeenCalled();
  });

  it('does not overwrite a Contract entry with a SAC entry for the same address', async () => {
    vi.mocked(prismaRead.contract.findMany).mockResolvedValue([
      { address: SOROBAN_ADDR, tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimals: 6 },
    ] as any);
    // SAC mapping uses the same address — should be skipped since Contract entry wins
    vi.mocked(prismaRead.sacMapping.findMany).mockResolvedValue([
      { sacAddress: SOROBAN_ADDR, assetCode: 'USDC', assetIssuer: 'GA5Z...' },
    ] as any);

    await warmTokenMetadataCache();

    // Verify via formatTokenAmountSync — it reads from cache only.
    // If the DB entry (decimals=6) was preserved, 10_000_000 → "10.000000 USDC"
    // If overwritten by SAC (decimals=7), it would be "1.0000000 USDC"
    const formatted = formatTokenAmountSync(10_000_000n, SOROBAN_ADDR);
    expect(formatted).toBe('10.000000 USDC');
  });
});

// ─── getTokenMetadataCacheSize ────────────────────────────────────────────────

describe('getTokenMetadataCacheSize', () => {
  it('returns 0 on empty cache', () => {
    expect(getTokenMetadataCacheSize()).toBe(0);
  });

  it('increments as entries are added', async () => {
    vi.mocked(prismaRead.contract.findUnique).mockResolvedValue({
      isToken: true,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      tokenDecimals: 6,
    } as any);

    await getTokenMetadata(SOROBAN_ADDR);
    expect(getTokenMetadataCacheSize()).toBe(1);
  });
});
