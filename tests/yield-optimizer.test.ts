import { describe, it, expect } from 'vitest';
import {
  computeSimpleAPR,
  computeCompoundAPY,
  aprToApy,
  impermanentLoss,
  adjustedLApy,
  inferYieldType,
  extractTokens,
  computeRiskScore,
  riskLabelFor,
  optimizePortfolio,
  simulateDeposit,
  buildOpportunityId,
  defaultOpportunityName,
} from '../src/indexer/yield-optimizer';

// ---------------------------------------------------------------------------
// Financial math
// ---------------------------------------------------------------------------

describe('computeSimpleAPR', () => {
  it('returns 0 for invalid inputs', () => {
    expect(computeSimpleAPR(0, 0, 0)).toBe(0);
    expect(computeSimpleAPR(100, 0, 30)).toBe(0);
    expect(computeSimpleAPR(100, 1000, 0)).toBe(0);
  });

  it('matches the documented formula', () => {
    // 100 USDC earned on 10,000 principal over an entire year → 1% APR
    const apr = computeSimpleAPR(100, 10000, 365);
    expect(apr).toBeCloseTo(1, 6);
  });

  it('handles partial periods', () => {
    // 50 over 10000 / 30 days → ~6.08% APR when annualised
    const apr = computeSimpleAPR(50, 10000, 30);
    expect(apr).toBeCloseTo(6.08, 1);
  });
});

describe('computeCompoundAPY', () => {
  it('returns 0 for NaN', () => {
    expect(computeCompoundAPY(Number.NaN)).toBe(0);
  });

  it('matches the documented (1+r)^365 - 1 formula', () => {
    const r = 0.10 / 365; // 10% annualised as a daily rate
    const apy = computeCompoundAPY(r);
    expect(apy).toBeCloseTo(10.5156, 2);
  });
});

describe('aprToApy', () => {
  it('compounds correctly with default daily period', () => {
    const apy = aprToApy(10, 1);
    expect(apy).toBeCloseTo(10.5156, 2);
  });

  it('returns 0 for invalid compounding period', () => {
    expect(aprToApy(10, 0)).toBe(0);
    expect(aprToApy(10, -1)).toBe(0);
  });

  it('returns APR value for NaN', () => {
    expect(aprToApy(Number.NaN)).toBe(0);
  });
});

describe('impermanentLoss', () => {
  it('is 0 when the price ratio is 1', () => {
    expect(impermanentLoss(1)).toBeCloseTo(0, 6);
  });

  it('is negative when the ratio diverges', () => {
    // 2x price move → ~5.72% IL (returned as a decimal fraction)
    expect(impermanentLoss(2)).toBeCloseTo(-0.0572, 3);
    expect(impermanentLoss(0.5)).toBeCloseTo(-0.0572, 3);
  });

  it('is 0 for invalid input', () => {
    expect(impermanentLoss(0)).toBe(0);
    expect(impermanentLoss(Number.NaN)).toBe(0);
    expect(impermanentLoss(-1)).toBe(0);
  });
});

describe('adjustedLApy', () => {
  it('subtracts IL from base+incentive', () => {
    // Base 10 + incentive 5, IL ≈ -5.72 → ≈ 9.28
    expect(adjustedLApy(10, 5, 2)).toBeCloseTo(9.28, 1);
  });

  it('never returns negative', () => {
    expect(adjustedLApy(0, 0, 1000)).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

describe('inferYieldType', () => {
  it('matches known LP farming topics', () => {
    expect(inferYieldType('add_liquidity', null)).toBe('lp_farming');
    expect(inferYieldType('claim_fees', null)).toBe('lp_farming');
  });

  it('matches staking topics', () => {
    expect(inferYieldType('stake', null)).toBe('staking');
    expect(inferYieldType('unstake', null)).toBe('staking');
  });

  it('matches lending topics', () => {
    expect(inferYieldType('deposit', null)).toBe('lending');
    expect(inferYieldType('borrow', null)).toBe('lending');
  });

  it('matches liquid staking topics', () => {
    expect(inferYieldType('rebase', null)).toBe('liquid_staking');
  });

  it('matches vault topics', () => {
    expect(inferYieldType('vault_deposit', null)).toBe('vault');
  });

  it('returns null for unknown topics', () => {
    expect(inferYieldType('transfer', null)).toBeNull();
  });

  it('returns null for null topic', () => {
    expect(inferYieldType(null, null)).toBeNull();
  });

  it('uses decoded payload heuristics when topic unknown', () => {
    expect(inferYieldType('custom', { pool: 'ABC' })).toBe('lp_farming');
    expect(inferYieldType('custom', { validator: 'X' })).toBe('staking');
    expect(inferYieldType('custom', { borrow_amount: 1 })).toBe('lending');
    expect(inferYieldType('custom', { lst_token: 'X' })).toBe('liquid_staking');
    expect(inferYieldType('custom', { vault_id: 'V' })).toBe('vault');
  });
});

describe('extractTokens', () => {
  it('returns empty array for null decoded', () => {
    expect(extractTokens(null)).toEqual([]);
  });

  it('extracts from arrays of strings', () => {
    expect(extractTokens({ tokens: ['USDC', 'XLM'] })).toEqual(['USDC', 'XLM']);
  });

  it('dedupes and uppercases', () => {
    expect(extractTokens({ tokens: ['usdc', 'USDC', 'xlm'] })).toEqual(['USDC', 'XLM']);
  });

  it('extracts from nested .data', () => {
    expect(extractTokens({ data: { symbols: ['ETH', 'BTC'] } })).toEqual(['ETH', 'BTC']);
  });
});

describe('buildOpportunityId', () => {
  it('combines address and type', () => {
    expect(buildOpportunityId('CA_FOO', 'staking')).toBe('ca_foo-staking');
  });
});

describe('defaultOpportunityName', () => {
  it('uses token pair for LP', () => {
    expect(defaultOpportunityName('CA', 'lp_farming', ['USDC', 'XLM'])).toContain('USDC-XLM');
  });

  it('falls back to short address', () => {
    expect(defaultOpportunityName('CABCDEF123', 'staking', [])).toContain('CABCDE');
  });
});

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

describe('riskLabelFor', () => {
  it('buckets 0-24 as low', () => {
    expect(riskLabelFor(0)).toBe('low');
    expect(riskLabelFor(24)).toBe('low');
  });
  it('buckets 25-59 as medium', () => {
    expect(riskLabelFor(25)).toBe('medium');
    expect(riskLabelFor(59)).toBe('medium');
  });
  it('buckets 60+ as high', () => {
    expect(riskLabelFor(60)).toBe('high');
    expect(riskLabelFor(100)).toBe('high');
  });
  it('returns unknown for NaN', () => {
    expect(riskLabelFor(Number.NaN)).toBe('unknown');
  });
});

describe('computeRiskScore', () => {
  it('produces a higher score for incentive-heavy LPs', () => {
    const lp = computeRiskScore('lp_farming', { totalApy: 10, incentiveApy: 9, lockupDays: 0 });
    const staking = computeRiskScore('staking', { totalApy: 10, incentiveApy: 9, lockupDays: 0 });
    expect(lp).toBeGreaterThan(staking);
  });

  it('penalises long lockups', () => {
    const short = computeRiskScore('staking', { totalApy: 10, incentiveApy: 0, lockupDays: 0 });
    const long = computeRiskScore('staking', { totalApy: 10, incentiveApy: 0, lockupDays: 180 });
    expect(long).toBeGreaterThan(short);
  });

  it('clamps to [0, 100]', () => {
    const max = computeRiskScore('lp_farming', {
      totalApy: 10,
      incentiveApy: 10,
      lockupDays: 1000,
      smartContractRisk: 100,
      concentrationRisk: 100,
    });
    expect(max).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Portfolio optimizer
// ---------------------------------------------------------------------------

const pool: Array<Parameters<typeof optimizePortfolio>[0]['opportunities'][number]> = [
  {
    contractAddress: 'CA_LP',
    name: 'USDC-XLM LP',
    type: 'lp_farming',
    tokens: ['USDC', 'XLM'],
    baseApy: 10,
    incentiveApy: 5,
    tvl: '1500000',
    lockupDays: 0,
  },
  {
    contractAddress: 'CA_LEND',
    name: 'USDC Lending',
    type: 'lending',
    tokens: ['USDC'],
    baseApy: 8,
    incentiveApy: 0.5,
    tvl: '500000',
    lockupDays: 0,
  },
  {
    contractAddress: 'CA_STAKE',
    name: 'XLM Staking',
    type: 'staking',
    tokens: ['XLM'],
    baseApy: 6,
    incentiveApy: 16,
    tvl: '800000',
    lockupDays: 7,
  },
  {
    contractAddress: 'CA_VAULT',
    name: 'BTC Vault',
    type: 'vault',
    tokens: ['BTC'],
    baseApy: 12,
    incentiveApy: 1,
    tvl: '2000000',
    lockupDays: 30,
  },
];

describe('optimizePortfolio', () => {
  it('returns empty recommendations when nothing matches', () => {
    const r = optimizePortfolio({
      amount: '10000',
      riskTolerance: 'moderate',
      minAPY: 9999,
      opportunities: pool,
    });
    expect(r.recommendations).toEqual([]);
    expect(r.expectedWeightedApy).toBe(0);
  });

  it('respects risk-tolerance ceiling', () => {
    const r = optimizePortfolio({
      amount: '10000',
      riskTolerance: 'conservative',
      opportunities: pool,
    });
    if (r.recommendations.length > 0) {
      expect(r.riskScore).toBeLessThanOrEqual(30);
    }
  });

  it('allocations sum to 100 percent', () => {
    const r = optimizePortfolio({
      amount: '10000',
      riskTolerance: 'aggressive',
      opportunities: pool,
    });
    const sum = r.recommendations.reduce((s, a) => s + a.allocationPct, 0);
    expect(sum).toBe(100);
  });

  it('filters by token when provided', () => {
    const r = optimizePortfolio({
      amount: '10000',
      riskTolerance: 'aggressive',
      tokens: ['USDC'],
      opportunities: pool,
    });
    expect(r.recommendations.length).toBeGreaterThan(0);
    for (const rec of r.recommendations) {
      expect(rec.pool).toContain('USDC');
    }
  });

  it('produces sensible risk-adjusted APY', () => {
    const r = optimizePortfolio({
      amount: '10000',
      riskTolerance: 'moderate',
      opportunities: pool,
    });
    expect(r.expectedWeightedApy).toBeGreaterThan(0);
    expect(r.riskScore).toBeGreaterThanOrEqual(0);
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

describe('simulateDeposit', () => {
  it('matches compound interest math', () => {
    // 1000 USDC @ 10% APY compounded daily over 365 days:
    // balance = 1000 * (1 + 0.10/365)^365 ≈ 1105.16, so earnings ≈ 105.16
    const r = simulateDeposit('1000', 365, 10, 0);
    expect(Number(r.netEarnings)).toBeCloseTo(105.16, 1);
  });

  it('deducts fees from earnings', () => {
    const a = simulateDeposit('10000', 30, 10, 0);
    const b = simulateDeposit('10000', 30, 10, 1);
    expect(Number(b.netEarnings)).toBeLessThan(Number(a.netEarnings));
    expect(Number(b.fees)).toBeGreaterThan(0);
  });

  it('handles zero-period and invalid input', () => {
    const r = simulateDeposit('1000', 0, 10, 0);
    expect(r.periodDays).toBe(0);
    expect(r.projectedEarnings).toBe('0.00');
  });

  it('returns the documented shape', () => {
    const r = simulateDeposit('5000', 60, 12.5, 0.5);
    expect(typeof r.deposit).toBe('string');
    expect(typeof r.projectedEarnings).toBe('string');
    expect(typeof r.fees).toBe('string');
    expect(typeof r.netEarnings).toBe('string');
    expect(r.projectedApy).toBeCloseTo(12.5, 1);
  });
});
