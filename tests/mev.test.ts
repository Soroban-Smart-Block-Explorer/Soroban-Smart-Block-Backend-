import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db', () => ({
  prismaRead: {
    mevEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    mevVictim: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    mevAttacker: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    protocolMevResistance: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    mevAlert: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    transaction: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {
    mevEvent: { upsert: vi.fn() },
    mevVictim: { upsert: vi.fn() },
    mevAttacker: { upsert: vi.fn() },
    mevAlert: { create: vi.fn() },
  },
}));

import { prismaRead, prismaWrite } from '../src/db';
import {
  classifyAndStore,
  classifyLedger,
  getMevOverview,
  getMevStatistics,
} from '../src/indexer/mev-classifier';

const mockEvent = {
  id: 'cuid1',
  txHash: 'tx1',
  ledgerSeq: 100,
  timestamp: new Date('2026-01-01'),
  mevType: 'sandwich' as const,
  victimAddress: 'VICTIM',
  attackerAddress: 'ATTACKER',
  protocolAddress: 'PROTO',
  tokenIn: 'USDC',
  tokenOut: 'XLM',
  amountIn: '100',
  amountOut: '98',
  profitAmount: '2',
  profitUsd: 2.0,
  lossAmount: '2',
  lossUsd: 2.0,
  txOrder: null,
  confidence: 0.9,
  details: null,
  createdAt: new Date('2026-01-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── classifyAndStore ──────────────────────────────────────────────────────────

describe('classifyAndStore', () => {
  it('upserts victim, attacker, and event', async () => {
    vi.mocked(prismaWrite.mevVictim.upsert).mockResolvedValue({} as never);
    vi.mocked(prismaWrite.mevAttacker.upsert).mockResolvedValue({} as never);
    vi.mocked(prismaWrite.mevEvent.upsert).mockResolvedValue(mockEvent as never);

    const result = await classifyAndStore({
      txHash: 'tx1',
      ledgerSeq: 100,
      timestamp: new Date('2026-01-01'),
      mevType: 'sandwich',
      victimAddress: 'VICTIM',
      attackerAddress: 'ATTACKER',
      confidence: 0.9,
      profitUsd: 2,
      lossUsd: 2,
    });

    expect(prismaWrite.mevVictim.upsert).toHaveBeenCalledOnce();
    expect(prismaWrite.mevAttacker.upsert).toHaveBeenCalledOnce();
    expect(prismaWrite.mevEvent.upsert).toHaveBeenCalledOnce();
    expect(result).toEqual(mockEvent);
  });

  it('skips victim upsert when victimAddress is absent', async () => {
    vi.mocked(prismaWrite.mevEvent.upsert).mockResolvedValue(mockEvent as never);

    await classifyAndStore({
      txHash: 'tx2',
      ledgerSeq: 101,
      timestamp: new Date(),
      mevType: 'backrunning',
      confidence: 0.7,
    });

    expect(prismaWrite.mevVictim.upsert).not.toHaveBeenCalled();
    expect(prismaWrite.mevAttacker.upsert).not.toHaveBeenCalled();
  });
});

// ── classifyLedger ────────────────────────────────────────────────────────────

describe('classifyLedger', () => {
  it('returns empty array when no transactions', async () => {
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([]);
    const result = await classifyLedger(42);
    expect(result).toEqual([]);
  });

  it('detects sandwich pattern', async () => {
    const base = {
      id: '1',
      ledgerSequence: 100,
      ledgerCloseTime: new Date(),
      contractAddress: 'PROTO',
      functionName: 'swap',
      humanReadable: null,
      status: 'success',
      rawXdr: '',
      flashLoanAlert: false,
      reentrantAlert: false,
      freezeViolation: false,
      feeCharged: null,
      sorobanResources: null,
      failureReason: null,
      functionArgs: null,
      events: [],
    };

    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      { ...base, id: '1', hash: 'frontTx', sourceAccount: 'ATTACKER' },
      { ...base, id: '2', hash: 'victimTx', sourceAccount: 'VICTIM' },
      { ...base, id: '3', hash: 'backTx', sourceAccount: 'ATTACKER' },
    ] as never);

    const result = await classifyLedger(100);

    expect(result).toHaveLength(1);
    expect(result[0].mevType).toBe('sandwich');
    expect(result[0].victimAddress).toBe('VICTIM');
    expect(result[0].attackerAddress).toBe('ATTACKER');
    expect(result[0].confidence).toBeGreaterThan(0);
  });

  it('detects flash loan alert', async () => {
    vi.mocked(prismaRead.transaction.findMany).mockResolvedValue([
      {
        id: '1',
        hash: 'flashTx',
        sourceAccount: 'ATTACKER',
        ledgerSequence: 200,
        ledgerCloseTime: new Date(),
        contractAddress: 'PROTO',
        functionName: 'flash_borrow',
        flashLoanAlert: true,
        humanReadable: null,
        status: 'success',
        rawXdr: '',
        reentrantAlert: false,
        freezeViolation: false,
        feeCharged: null,
        sorobanResources: null,
        failureReason: null,
        functionArgs: null,
        events: [],
      },
    ] as never);

    const result = await classifyLedger(200);

    expect(result).toHaveLength(1);
    expect(result[0].mevType).toBe('flash_loan_attack');
    expect(result[0].attackerAddress).toBe('ATTACKER');
  });
});

// ── getMevOverview ────────────────────────────────────────────────────────────

describe('getMevOverview', () => {
  it('returns aggregated overview', async () => {
    vi.mocked(prismaRead.mevEvent.count).mockResolvedValue(42);
    vi.mocked(prismaRead.mevEvent.aggregate)
      .mockResolvedValueOnce({ _sum: { profitUsd: 100.5 } } as never)
      .mockResolvedValueOnce({ _sum: { lossUsd: 50.25 } } as never);
    vi.mocked(prismaRead.mevEvent.groupBy).mockResolvedValue([
      { mevType: 'sandwich', _count: { id: 30 } },
      { mevType: 'flash_loan_attack', _count: { id: 12 } },
    ] as never);
    vi.mocked(prismaRead.mevAttacker.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.mevVictim.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue([]);

    const overview = await getMevOverview();

    expect(overview.totalEvents).toBe(42);
    expect(overview.totalProfitUsd).toBe(100.5);
    expect(overview.totalLossUsd).toBe(50.25);
    expect(overview.byType['sandwich']).toBe(30);
    expect(overview.byType['flash_loan_attack']).toBe(12);
  });
});

// ── getMevStatistics ──────────────────────────────────────────────────────────

describe('getMevStatistics', () => {
  it('returns statistics including counts by type', async () => {
    vi.mocked(prismaRead.mevEvent.count)
      .mockResolvedValueOnce(50) // totalEvents in overview
      .mockResolvedValueOnce(20) // sandwichCount
      .mockResolvedValueOnce(10) // flashLoanCount
      .mockResolvedValueOnce(5); // arbCount
    vi.mocked(prismaRead.mevEvent.aggregate)
      .mockResolvedValue({ _sum: { profitUsd: 0, lossUsd: 0 }, _avg: { confidence: 0.88 } } as never);
    vi.mocked(prismaRead.mevEvent.groupBy).mockResolvedValue([] as never);
    vi.mocked(prismaRead.mevAttacker.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.mevAttacker.count).mockResolvedValue(3);
    vi.mocked(prismaRead.mevVictim.findMany).mockResolvedValue([]);
    vi.mocked(prismaRead.mevVictim.count).mockResolvedValue(7);
    vi.mocked(prismaRead.mevEvent.findMany).mockResolvedValue([]);

    const stats = await getMevStatistics();

    expect(stats.totalAttackers).toBe(3);
    expect(stats.totalVictims).toBe(7);
    expect(stats.sandwichCount).toBe(20);
    expect(stats.flashLoanCount).toBe(10);
    expect(stats.arbitrageCount).toBe(5);
  });
});
