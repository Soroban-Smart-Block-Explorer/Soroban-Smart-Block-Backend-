import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  prismaRead: {
    transaction: { findMany: vi.fn() },
    poolPrice: { findMany: vi.fn() },
    priceDeviation: { findMany: vi.fn() },
    mevEvent: { findMany: vi.fn() },
  },
  prismaWrite: {},
}));

import { prismaRead } from '../src/db';
import {
  generateMevPredictions,
  ingestPendingTransaction,
  listPendingTransactions,
  clearPendingTransactions,
  getPendingTransactionCount,
  predictFromInputs,
  resolveSensitivity,
  scoreSignalFeatures,
  sensitivityThreshold,
  type DexPoolState,
  type DeviationInput,
  type MevHistoryEntry,
  type PendingTransaction,
} from '../src/indexer/mev-predictor';

const NOW = new Date('2026-06-19T07:24:26.000Z');

function pool(overrides: Partial<DexPoolState> = {}): DexPoolState {
  return {
    poolId: 'pool-1',
    contractAddress: 'CCONTRACT1',
    dexName: 'Aquarius',
    pair: 'XLM/USDC',
    tokenA: 'XLM',
    tokenB: 'USDC',
    spotPrice: 1.05,
    twap5m: 1.0,
    liquidityUsd: 1_000_000,
    volume24hUsd: 50_000,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function deviation(overrides: Partial<DeviationInput> = {}): DeviationInput {
  return {
    poolIdA: 'pool-1',
    poolIdB: 'pool-2',
    tokenA: 'XLM',
    tokenB: 'USDC',
    priceA: 1.0,
    priceB: 1.02,
    deviationPercentage: 2.0,
    timestamp: NOW.toISOString(),
    ...overrides,
  };
}

function arbHistory(count: number): MevHistoryEntry[] {
  return Array.from({ length: count }, () => ({
    mevType: 'cross_dex_arbitrage',
    protocolAddress: 'CCONTRACT1',
    tokenIn: 'USDC',
    tokenOut: 'XLM',
    confidence: 0.9,
    timestamp: NOW.toISOString(),
  }));
}

function pendingSwap(overrides: Partial<PendingTransaction> = {}): PendingTransaction {
  return {
    hash: 'pending-tx-1',
    sourceAccount: 'GSRC',
    contractAddress: 'CCONTRACT1',
    functionName: 'swap',
    notionalUsd: 50_000,
    submittedAt: NOW.toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingTransactions();
});

// ── Pure scoring ──────────────────────────────────────────────────────────────

describe('scoreSignalFeatures', () => {
  it('returns 0 for an empty feature vector and 1 for saturated features', () => {
    expect(scoreSignalFeatures('arbitrage', {}, 0.5)).toBe(0);
    expect(
      scoreSignalFeatures('arbitrage', { deviation: 1, liquidity: 1, history: 1, mempool: 1 }, 0.5),
    ).toBeCloseTo(1, 5);
  });

  it('clamps out-of-range features into 0..1', () => {
    const clamped = scoreSignalFeatures('arbitrage', { deviation: 99, liquidity: -5 }, 0.5);
    const saturated = scoreSignalFeatures('arbitrage', { deviation: 1, liquidity: 0 }, 0.5);
    expect(clamped).toBeCloseTo(saturated, 5);
  });

  it('is deterministic for identical inputs', () => {
    const features = { deviation: 0.6, liquidity: 0.4, mempool: 0.2 };
    expect(scoreSignalFeatures('arbitrage', features, 0.7)).toBe(
      scoreSignalFeatures('arbitrage', features, 0.7),
    );
  });
});

describe('sensitivity configuration', () => {
  it('lowers the pass threshold as sensitivity increases', () => {
    expect(sensitivityThreshold(0.25)).toBeGreaterThan(sensitivityThreshold(0.5));
    expect(sensitivityThreshold(0.5)).toBeGreaterThan(sensitivityThreshold(0.8));
  });

  it('resolves named presets and numeric values', () => {
    expect(resolveSensitivity('conservative')).toBe(0.25);
    expect(resolveSensitivity('balanced')).toBe(0.5);
    expect(resolveSensitivity('aggressive')).toBe(0.8);
    expect(resolveSensitivity(0.4)).toBe(0.4);
    expect(resolveSensitivity('0.9')).toBe(0.9);
    expect(resolveSensitivity(undefined)).toBe(0.5);
  });
});

// ── predictFromInputs ─────────────────────────────────────────────────────────

describe('predictFromInputs', () => {
  it('ranks a strong arbitrage dislocated pair above the threshold', () => {
    const result = predictFromInputs(
      {
        pools: [pool()],
        deviations: [deviation()],
        history: arbHistory(10),
        pendingTransactions: [
          pendingSwap({ hash: 'p1' }),
          pendingSwap({ hash: 'p2' }),
          pendingSwap({ hash: 'p3' }),
        ],
      },
      { now: NOW, sensitivity: 0.5 },
    );

    const arb = result.predictions.find((p) => p.type === 'arbitrage');
    expect(arb).toBeDefined();
    expect(arb!.score).toBeGreaterThanOrEqual(result.threshold);
    expect(arb!.target.pair).toBe('USDC/XLM');
    expect(arb!.rationale.join(' ')).toContain('Cross-DEX deviation');
  });

  it('produces deterministic ids and non-increasing scores', () => {
    const inputs = { pools: [pool()], deviations: [deviation()], history: arbHistory(10) };
    const first = predictFromInputs(inputs, { now: NOW });
    const second = predictFromInputs(inputs, { now: NOW });

    expect(first.predictions.map((p) => p.id)).toEqual(second.predictions.map((p) => p.id));
    const scores = first.predictions.map((p) => p.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('surfaces fewer signals at conservative sensitivity than aggressive', () => {
    const inputs = {
      pools: [pool(), pool({ poolId: 'pool-2', contractAddress: 'CCONTRACT2' })],
      deviations: [
        deviation({ deviationPercentage: 2.0 }),
        deviation({
          poolIdA: 'pool-2',
          poolIdB: 'pool-2',
          tokenA: 'A',
          tokenB: 'B',
          deviationPercentage: 1.2,
        }),
      ],
    };

    const conservative = predictFromInputs(inputs, { now: NOW, sensitivity: 0.25 });
    const aggressive = predictFromInputs(inputs, { now: NOW, sensitivity: 0.8 });

    expect(aggressive.predictions.length).toBeGreaterThan(conservative.predictions.length);
    expect(conservative.threshold).toBeGreaterThan(aggressive.threshold);
  });

  it('honours a hard minScore floor on top of sensitivity', () => {
    const result = predictFromInputs(
      { pools: [pool()], deviations: [deviation({ deviationPercentage: 0.8 })] },
      { now: NOW, sensitivity: 0.9, minScore: 100 },
    );
    expect(result.threshold).toBe(100);
    expect(result.predictions).toHaveLength(0);
  });

  it('filters by type and stage', () => {
    const result = predictFromInputs(
      {
        pools: [pool()],
        deviations: [deviation()],
        history: arbHistory(10),
        pendingTransactions: [
          pendingSwap(),
          pendingSwap({
            hash: 'liq',
            functionName: 'liquidate_position',
            notionalUsd: 200_000,
          }),
        ],
      },
      { now: NOW, types: ['sandwich'], stage: 'pending' },
    );
    expect(result.predictions.every((p) => p.type === 'sandwich' && p.stage === 'pending')).toBe(
      true,
    );
  });

  it('scores a large pending swap as a sandwich candidate targeting the tx', () => {
    const result = predictFromInputs(
      { pools: [pool()], pendingTransactions: [pendingSwap()] },
      { now: NOW, sensitivity: 0.5 },
    );
    const sandwich = result.predictions.find((p) => p.type === 'sandwich');
    expect(sandwich).toBeDefined();
    expect(sandwich!.target.txHash).toBe('pending-tx-1');
    expect(sandwich!.expectedProfitUsd).toBeGreaterThan(0);
  });

  it('detects an explicit liquidation signature', () => {
    const result = predictFromInputs(
      {
        pools: [pool({ spotPrice: 1.2, twap5m: 1.0 })],
        pendingTransactions: [
          pendingSwap({ hash: 'liq-tx', functionName: 'liquidate_position', notionalUsd: 500_000 }),
        ],
      },
      { now: NOW, sensitivity: 0.8, types: ['liquidation'] },
    );
    expect(result.predictions.some((p) => p.type === 'liquidation')).toBe(true);
  });

  it('is pure — does not mutate its inputs', () => {
    const pools = [pool()];
    const deviations = [deviation()];
    const pendingTransactions = [pendingSwap()];
    const inputs = { pools, deviations, pendingTransactions };
    predictFromInputs(inputs, { now: NOW });
    expect(pools).toHaveLength(1);
    expect(deviations).toHaveLength(1);
    expect(pendingTransactions).toHaveLength(1);
    expect(pendingTransactions[0]).toEqual(pendingSwap());
  });

  it('ignores inputs outside the lookback window', () => {
    const stale = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const result = predictFromInputs(
      {
        pools: [pool()],
        deviations: [deviation({ timestamp: stale })],
        pendingTransactions: [pendingSwap({ submittedAt: stale })],
      },
      { now: NOW, lookbackMinutes: 5 },
    );
    expect(result.sources.deviationCount).toBe(0);
    expect(result.sources.pendingTxCount).toBe(0);
  });

  it('does not inflate liquidity when pool state is missing', () => {
    const result = predictFromInputs({ deviations: [deviation()] }, { now: NOW, sensitivity: 0.9 });
    const arb = result.predictions.find((p) => p.type === 'arbitrage');
    if (arb) expect(arb.features.liquidity).toBe(0);
  });
});

// ── Pending transaction buffer ────────────────────────────────────────────────

describe('pending transaction buffer', () => {
  it('ingests, dedupes by hash, and lists pending transactions', () => {
    ingestPendingTransaction(pendingSwap(), NOW);
    ingestPendingTransaction(pendingSwap({ notionalUsd: 90_000 }), NOW);
    const pending = listPendingTransactions(NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0].notionalUsd).toBe(90_000);
  });

  it('prunes entries older than the TTL', () => {
    const old = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    ingestPendingTransaction(pendingSwap({ submittedAt: old }), NOW);
    expect(getPendingTransactionCount()).toBe(1);
    listPendingTransactions(NOW);
    expect(getPendingTransactionCount()).toBe(0);
  });

  it('clears the buffer', () => {
    ingestPendingTransaction(pendingSwap(), NOW);
    clearPendingTransactions();
    expect(listPendingTransactions(NOW)).toHaveLength(0);
  });
});

// ── DB-backed generation (read-only) ──────────────────────────────────────────

describe('generateMevPredictions', () => {
  function mockDb() {
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      {
        hash: 'recent-tx-1',
        sourceAccount: 'GSRC',
        contractAddress: 'CCONTRACT1',
        functionName: 'swap',
        ledgerSequence: 100,
        ledgerCloseTime: NOW,
        status: 'success',
      },
    ] as never);
    vi.mocked(prismaRead.poolPrice.findMany).mockResolvedValue([
      {
        poolId: 'pool-1',
        spotPrice: 1.05,
        twap5m: 1.0,
        timestamp: NOW,
        pool: {
          contractAddress: 'CCONTRACT1',
          dexName: 'Aquarius',
          tokenA: 'XLM',
          tokenB: 'USDC',
          tokenASymbol: 'XLM',
          tokenBSymbol: 'USDC',
          tvlUsd: 1_000_000,
          reserveA: 100,
          reserveB: 100,
          priceAUsd: 1,
          priceBUsd: 1,
          volume24hUsd: 50_000,
        },
      },
    ] as never);
    vi.mocked(prismaRead.priceDeviation.findMany).mockResolvedValue([
      {
        poolIdA: 'pool-1',
        poolIdB: 'pool-1',
        tokenA: 'XLM',
        tokenB: 'USDC',
        priceA: 1,
        priceB: 1.02,
        deviationPercentage: 2,
        timestamp: NOW,
      },
    ] as never);
    vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue(arbHistory(10) as never);
  }

  it('builds ranked predictions from indexed state and reports sources', async () => {
    mockDb();
    const result = await generateMevPredictions({ now: NOW, sensitivity: 0.5 });

    expect(result.count).toBeGreaterThan(0);
    expect(result.sources.recentTxCount).toBe(1);
    expect(result.sources.poolCount).toBe(1);
    expect(result.sources.deviationCount).toBe(1);
    expect(result.predictions[0].score).toBeGreaterThanOrEqual(result.threshold);
  });

  it('includes buffered pending transactions without persisting anything', async () => {
    mockDb();
    ingestPendingTransaction(pendingSwap(), NOW);
    const before = getPendingTransactionCount();
    const result = await generateMevPredictions({ now: NOW, types: ['sandwich'] });

    expect(result.sources.pendingTxCount).toBe(1);
    expect(getPendingTransactionCount()).toBe(before);
    expect(result.predictions.some((p) => p.type === 'sandwich')).toBe(true);
  });

  it('degrades gracefully when data sources are unavailable', async () => {
    vi.mocked(prismaRead.transaction.findMany).mockRejectedValue(new Error('db down'));
    vi.mocked(prismaRead.poolPrice.findMany).mockRejectedValue(new Error('db down'));
    vi.mocked(prismaRead.priceDeviation.findMany).mockRejectedValue(new Error('db down'));
    vi.mocked(prismaRead.mevEvent.findMany).mockRejectedValue(new Error('db down'));

    const result = await generateMevPredictions({ now: NOW });
    expect(result.sources).toEqual({
      pendingTxCount: 0,
      recentTxCount: 0,
      poolCount: 0,
      deviationCount: 0,
      historyEventCount: 0,
    });
    expect(result.predictions).toEqual([]);
  });
});
