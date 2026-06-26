import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

vi.mock('../src/db', () => ({
  prismaRead: {
    protocolRevenue: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    feeEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
    },
    yieldSnapshot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    protocolProfile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    revenueAlert: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  prismaWrite: {
    feeEvent: { createMany: vi.fn() },
    protocolRevenue: { upsert: vi.fn() },
    yieldSnapshot: { create: vi.fn() },
    protocolProfile: { upsert: vi.fn() },
    revenueAlert: { create: vi.fn(), update: vi.fn() },
  },
}));

import { prismaRead, prismaWrite } from '../src/db';
import {
  classifyFeeType,
  classifyDestination,
  extractAmount,
  extractToken,
  classifyAndStore,
  computeLpApr,
  computeStakingApr,
  computeApy,
  detectAnomalies,
  type RawEvent,
} from '../src/indexer/fee-classifier';
import {
  predictRevenue,
  runHourlyAggregation,
} from '../src/indexer/fee-aggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    txHash: 'txhash1',
    contractAddress: 'CABC123',
    topics: ['swap_fee'],
    data: '1000 USDC',
    blockNumber: 100,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fee type classification
// ---------------------------------------------------------------------------

describe('classifyFeeType', () => {
  it('classifies swap', () => {
    expect(classifyFeeType(makeEvent({ topics: ['swap_fee'] }))).toBe('SWAP');
  });

  it('classifies flash loan', () => {
    expect(classifyFeeType(makeEvent({ topics: ['flash_loan_fee'] }))).toBe('FLASH_LOAN');
  });

  it('classifies liquidation', () => {
    expect(classifyFeeType(makeEvent({ topics: ['liquidate_position'] }))).toBe('LIQUIDATION');
  });

  it('classifies withdrawal', () => {
    expect(classifyFeeType(makeEvent({ topics: ['withdraw_fee'] }))).toBe('WITHDRAWAL');
  });

  it('classifies performance fee', () => {
    expect(classifyFeeType(makeEvent({ topics: ['performance_fee'] }))).toBe('PERFORMANCE');
  });

  it('classifies protocol fee', () => {
    expect(classifyFeeType(makeEvent({ topics: ['protocol_fee'] }))).toBe('PROTOCOL');
  });

  it('classifies interest spread', () => {
    expect(classifyFeeType(makeEvent({ topics: ['borrow_interest'] }))).toBe('INTEREST_SPREAD');
  });

  it('classifies referral fee', () => {
    expect(classifyFeeType(makeEvent({ topics: ['referral_fee'] }))).toBe('REFERRAL');
  });

  it('classifies insurance contribution', () => {
    expect(classifyFeeType(makeEvent({ topics: ['insurance_contribution'] }))).toBe('INSURANCE_CONTRIBUTION');
  });

  it('returns null for unrelated events', () => {
    expect(classifyFeeType(makeEvent({ topics: ['price_update'], data: 'nothing' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Destination classification
// ---------------------------------------------------------------------------

describe('classifyDestination', () => {
  it('classifies buyback/burn', () => {
    expect(classifyDestination(makeEvent({ topics: ['buyback'], receiver: 'burn_address' }))).toBe('BUYBACK_BURN');
  });

  it('classifies treasury', () => {
    expect(classifyDestination(makeEvent({ receiver: 'treasury_contract' }))).toBe('TREASURY');
  });

  it('classifies staker rewards', () => {
    expect(classifyDestination(makeEvent({ receiver: 'staking_contract' }))).toBe('STAKER_REWARDS');
  });

  it('classifies insurance fund', () => {
    expect(classifyDestination(makeEvent({ receiver: 'insurance_fund' }))).toBe('INSURANCE_FUND');
  });

  it('defaults to LP_REWARDS', () => {
    expect(classifyDestination(makeEvent({ receiver: 'unknown_address', topics: [], data: '' }))).toBe('LP_REWARDS');
  });
});

// ---------------------------------------------------------------------------
// Amount and token extraction
// ---------------------------------------------------------------------------

describe('extractAmount / extractToken', () => {
  it('extracts numeric amount', () => {
    expect(extractAmount(makeEvent({ data: '1234.56 USDC' }))).toBe('1234.56');
  });

  it('returns 0 for no number', () => {
    expect(extractAmount(makeEvent({ data: 'no number here' }))).toBe('0');
  });

  it('extracts token symbol', () => {
    expect(extractToken(makeEvent({ data: '100 USDC transfer' }))).toBe('USDC');
  });

  it('returns XLM fallback', () => {
    expect(extractToken(makeEvent({ data: '123 456' }))).toBe('XLM');
  });
});

// ---------------------------------------------------------------------------
// APR / APY formulas
// ---------------------------------------------------------------------------

describe('APR/APY computation', () => {
  it('computes LP APR correctly', () => {
    // $1000 rewards / $10000 TVL * 365 periods = 3650%
    expect(computeLpApr(1000, 10000, 365)).toBeCloseTo(3650);
  });

  it('returns 0 for zero TVL', () => {
    expect(computeLpApr(1000, 0, 365)).toBe(0);
  });

  it('computes staking APR correctly', () => {
    expect(computeStakingApr(500, 5000, 365)).toBeCloseTo(3650);
  });

  it('computes APY from APR with daily compounding', () => {
    // 100% APR → APY ≈ 171.46%
    const apy = computeApy(100, 365);
    expect(apy).toBeGreaterThan(170);
    expect(apy).toBeLessThan(173);
  });

  it('returns 0 for zero APR', () => {
    expect(computeApy(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyAndStore
// ---------------------------------------------------------------------------

describe('classifyAndStore', () => {
  it('skips unclassifiable events', async () => {
    const result = await classifyAndStore([
      makeEvent({ topics: ['price_update'], data: 'nothing' }),
    ]);
    expect(result).toHaveLength(0);
    expect(prismaWrite.feeEvent.createMany).not.toHaveBeenCalled();
  });

  it('stores classified events', async () => {
    vi.mocked(prismaWrite.feeEvent.createMany).mockResolvedValue({ count: 1 });
    const result = await classifyAndStore([
      makeEvent({ topics: ['swap_fee'], data: '100 USDC' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].feeType).toBe('SWAP');
    expect(prismaWrite.feeEvent.createMany).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// predictRevenue
// ---------------------------------------------------------------------------

describe('predictRevenue', () => {
  it('returns correct number of forecast days', () => {
    const history = [100, 110, 120, 130, 140];
    const { dates, revenue, lower, upper } = predictRevenue(history, 7);
    expect(dates).toHaveLength(7);
    expect(revenue).toHaveLength(7);
    expect(lower).toHaveLength(7);
    expect(upper).toHaveLength(7);
  });

  it('forecasts upward trend from rising data', () => {
    const history = Array.from({ length: 30 }, (_, i) => 100 + i * 10);
    const { revenue } = predictRevenue(history, 5);
    expect(revenue[4]).toBeGreaterThan(revenue[0]);
  });

  it('handles flat history', () => {
    const history = [100, 100, 100, 100, 100];
    const { revenue } = predictRevenue(history, 3);
    revenue.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
  });

  it('handles single-value history with fallback', () => {
    const { dates, revenue } = predictRevenue([50], 3);
    expect(dates).toHaveLength(3);
    revenue.forEach((v) => expect(v).toBe(50));
  });

  it('lower bound is always <= predicted and >= 0', () => {
    const history = [100, 110, 105, 120, 115, 130, 125];
    const { revenue, lower } = predictRevenue(history, 10);
    revenue.forEach((v, i) => {
      expect(lower[i]).toBeLessThanOrEqual(v + 0.001);
      expect(lower[i]).toBeGreaterThanOrEqual(0);
    });
  });

  it('upper bound is always >= predicted', () => {
    const history = [100, 110, 105, 120, 115, 130, 125];
    const { revenue, upper } = predictRevenue(history, 10);
    revenue.forEach((v, i) => {
      expect(upper[i]).toBeGreaterThanOrEqual(v - 0.001);
    });
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

describe('detectAnomalies', () => {
  it('creates spike alert when revenue 3x above baseline', async () => {
    const makeRow = (fees: number, i: number) => ({
      id: String(i),
      contractAddress: 'CABC',
      protocolName: null,
      period: 'DAY' as const,
      timestamp: new Date(),
      totalFees: fees,
      swapFees: null, withdrawFees: null, performanceFees: null,
      protocolFees: null, liquidationFees: null, interestSpread: null,
      flashLoanFees: null, referralFees: null, lpRewards: null,
      treasuryAmount: null, burnedAmount: null, stakerRewards: null,
      insuranceFund: null, ecosystemFund: null, teamVesting: null,
      feeToken: 'XLM', usdValue: null, txCount: 1, uniqueUsers: null,
    });

    // Latest row is 10x the baseline of 100
    const rows = [
      makeRow(1000, 0), // latest
      ...Array.from({ length: 7 }, (_, i) => makeRow(100, i + 1)), // baseline
    ];
    vi.mocked(prismaRead.protocolRevenue.findMany).mockResolvedValue(rows as never);
    vi.mocked(prismaWrite.revenueAlert.create).mockResolvedValue({} as never);

    await detectAnomalies('CABC');

    expect(prismaWrite.revenueAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alertType: 'revenue_spike' }),
      }),
    );
  });

  it('creates drop alert when revenue falls below 20% of baseline', async () => {
    const makeRow = (fees: number, i: number) => ({
      id: String(i),
      contractAddress: 'CABC',
      protocolName: null,
      period: 'DAY' as const,
      timestamp: new Date(),
      totalFees: fees,
      swapFees: null, withdrawFees: null, performanceFees: null,
      protocolFees: null, liquidationFees: null, interestSpread: null,
      flashLoanFees: null, referralFees: null, lpRewards: null,
      treasuryAmount: null, burnedAmount: null, stakerRewards: null,
      insuranceFund: null, ecosystemFund: null, teamVesting: null,
      feeToken: 'XLM', usdValue: null, txCount: 1, uniqueUsers: null,
    });

    const rows = [
      makeRow(10, 0), // latest — 10% of 100 baseline
      ...Array.from({ length: 7 }, (_, i) => makeRow(100, i + 1)),
    ];
    vi.mocked(prismaRead.protocolRevenue.findMany).mockResolvedValue(rows as never);
    vi.mocked(prismaWrite.revenueAlert.create).mockResolvedValue({} as never);

    await detectAnomalies('CABC');

    expect(prismaWrite.revenueAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alertType: 'revenue_drop' }),
      }),
    );
  });

  it('does not alert when within normal range', async () => {
    const makeRow = (fees: number, i: number) => ({
      id: String(i),
      contractAddress: 'CABC',
      protocolName: null,
      period: 'DAY' as const,
      timestamp: new Date(),
      totalFees: fees,
      swapFees: null, withdrawFees: null, performanceFees: null,
      protocolFees: null, liquidationFees: null, interestSpread: null,
      flashLoanFees: null, referralFees: null, lpRewards: null,
      treasuryAmount: null, burnedAmount: null, stakerRewards: null,
      insuranceFund: null, ecosystemFund: null, teamVesting: null,
      feeToken: 'XLM', usdValue: null, txCount: 1, uniqueUsers: null,
    });

    const rows = [
      makeRow(110, 0), // 1.1x baseline — normal
      ...Array.from({ length: 7 }, (_, i) => makeRow(100, i + 1)),
    ];
    vi.mocked(prismaRead.protocolRevenue.findMany).mockResolvedValue(rows as never);

    await detectAnomalies('CABC');

    expect(prismaWrite.revenueAlert.create).not.toHaveBeenCalled();
  });

  it('skips anomaly check when fewer than 7 days of history', async () => {
    vi.mocked(prismaRead.protocolRevenue.findMany).mockResolvedValue([]);
    await detectAnomalies('CABC');
    expect(prismaWrite.revenueAlert.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runHourlyAggregation — smoke test
// ---------------------------------------------------------------------------

describe('runHourlyAggregation', () => {
  it('runs without throwing when no events exist', async () => {
    vi.mocked(prismaRead.feeEvent.findMany).mockResolvedValue([]);
    await expect(runHourlyAggregation()).resolves.toBeUndefined();
  });
});
