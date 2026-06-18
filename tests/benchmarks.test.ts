import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

const { prismaReadMock, prismaWriteMock } = vi.hoisted(() => ({
  prismaReadMock: {
    operationBenchmark: { findMany: vi.fn() },
    transaction: { findMany: vi.fn(), count: vi.fn() },
    contract: { findUnique: vi.fn(), findMany: vi.fn() },
    contractBenchmarkSnapshot: { findMany: vi.fn() },
    gasGolfingTip: { findUnique: vi.fn() },
    standardCompliance: { findMany: vi.fn() },
  },
  prismaWriteMock: {},
}));

vi.mock('../src/db', () => ({
  prismaRead: prismaReadMock,
  prismaWrite: prismaWriteMock,
}));

import { benchmarkRouter } from '../src/api/benchmarks';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/benchmarks', benchmarkRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
});

const SOROBAN_RESOURCES = {
  cpuInstructions: 45000,
  memBytes: 256000,
  ledgerReadBytes: 2048,
  ledgerWriteBytes: 512,
  ledgerReadEntries: 5,
  ledgerWriteEntries: 2,
};

const TX_FIXTURE = {
  hash: 'tx-hash-1',
  contractAddress: 'CAAAA',
  functionName: 'transfer',
  feeCharged: '5000',
  sorobanResources: SOROBAN_RESOURCES,
  status: 'success',
  ledgerCloseTime: new Date('2026-06-01T00:00:00Z'),
};

const TX_FIXTURE_2 = {
  hash: 'tx-hash-2',
  contractAddress: 'CBBBB',
  functionName: 'swap',
  feeCharged: '12000',
  sorobanResources: { ...SOROBAN_RESOURCES, cpuInstructions: 85000, memBytes: 512000 },
  status: 'success',
  ledgerCloseTime: new Date('2026-06-02T00:00:00Z'),
};

// ── GET /api/v1/benchmarks/operations ──────────────────────────────────────────

describe('GET /api/v1/benchmarks/operations', () => {
  it('returns operation benchmarks', async () => {
    prismaReadMock.operationBenchmark.findMany.mockResolvedValue([
      {
        id: '1',
        name: 'token_transfer',
        avgCpu: 45000,
        avgMemory: 256000,
        avgFeeStroops: BigInt(5000),
        samples: 15000,
        lastUpdated: new Date('2026-06-15T00:00:00Z'),
        createdAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/operations`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0].name).toBe('token_transfer');
    expect(body.operations[0].avgCpu).toBe(45000);
    expect(body.operations[0].avgFee).toContain('XLM');
  });

  it('returns empty operations array when no benchmarks exist', async () => {
    prismaReadMock.operationBenchmark.findMany.mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/operations`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.operations).toEqual([]);
  });
});

// ── GET /api/v1/benchmarks/compare ─────────────────────────────────────────────

describe('GET /api/v1/benchmarks/compare', () => {
  it('compares two contracts side-by-side', async () => {
    prismaReadMock.transaction.findMany
      .mockResolvedValueOnce([
        { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '4000', sorobanResources: SOROBAN_RESOURCES },
        { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '6000', sorobanResources: SOROBAN_RESOURCES },
        { ...TX_FIXTURE, functionName: 'balance_of', feeCharged: '2000', sorobanResources: { ...SOROBAN_RESOURCES, cpuInstructions: 10000 } },
      ])
      .mockResolvedValueOnce([
        { ...TX_FIXTURE_2, functionName: 'transfer', feeCharged: '3000', sorobanResources: SOROBAN_RESOURCES },
        { ...TX_FIXTURE_2, functionName: 'swap', feeCharged: '12000', sorobanResources: { ...SOROBAN_RESOURCES, cpuInstructions: 85000 } },
      ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/compare?contractA=CAAAA&contractB=CBBBB`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contractA).toBe('CAAAA');
    expect(body.contractB).toBe('CBBBB');
    expect(body.comparison.length).toBeGreaterThan(0);
    const transferComparison = body.comparison.find((c: any) => c.functionName === 'transfer');
    expect(transferComparison).toBeDefined();
    expect(transferComparison.contractA).not.toBeNull();
    expect(transferComparison.contractB).not.toBeNull();
    expect(transferComparison.moreEfficient).toBeTruthy();
  });

  it('returns 400 for missing contract parameters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/benchmarks/compare?contractA=CAAAA`);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/benchmarks/contracts/:address/trends ──────────────────────────

describe('GET /api/v1/benchmarks/contracts/:address/trends', () => {
  it('detects regressions when cost increases >20%', async () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    prismaReadMock.contractBenchmarkSnapshot.findMany.mockResolvedValue([
      {
        id: '1',
        contractAddress: 'CAAAA',
        functionName: 'transfer',
        avgCpu: 40000,
        avgMemory: 200000,
        avgFeeStroops: BigInt(4000),
        minFeeStroops: BigInt(3000),
        maxFeeStroops: BigInt(5000),
        minCpu: 30000,
        maxCpu: 50000,
        samples: 100,
        ledgerSequence: 1000,
        createdAt: new Date(twoWeeksAgo.getTime() - 86400000),
      },
      {
        id: '2',
        contractAddress: 'CAAAA',
        functionName: 'transfer',
        avgCpu: 60000,
        avgMemory: 300000,
        avgFeeStroops: BigInt(6000),
        minFeeStroops: BigInt(4000),
        maxFeeStroops: BigInt(8000),
        minCpu: 40000,
        maxCpu: 70000,
        samples: 80,
        ledgerSequence: 2000,
        createdAt: new Date(),
      },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/contracts/CAAAA/trends?days=30`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contractAddress).toBe('CAAAA');
    expect(body.trends.length).toBeGreaterThan(0);
    expect(body.alerts.length).toBeGreaterThan(0);
    expect(body.alerts[0]).toContain('regression');
  });

  it('returns no alerts for stable costs', async () => {
    const now = new Date();
    prismaReadMock.contractBenchmarkSnapshot.findMany.mockResolvedValue([
      {
        id: '1',
        contractAddress: 'CAAAA',
        functionName: 'transfer',
        avgCpu: 40000,
        avgMemory: 200000,
        avgFeeStroops: BigInt(4000),
        minFeeStroops: BigInt(3000),
        maxFeeStroops: BigInt(5000),
        minCpu: 30000,
        maxCpu: 50000,
        samples: 100,
        ledgerSequence: 1000,
        createdAt: new Date(now.getTime() - 86400000),
      },
      {
        id: '2',
        contractAddress: 'CAAAA',
        functionName: 'transfer',
        avgCpu: 41000,
        avgMemory: 205000,
        avgFeeStroops: BigInt(4100),
        minFeeStroops: BigInt(3500),
        maxFeeStroops: BigInt(4800),
        minCpu: 35000,
        maxCpu: 48000,
        samples: 90,
        ledgerSequence: 2000,
        createdAt: now,
      },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/contracts/CAAAA/trends?days=7`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alerts).toHaveLength(0);
  });
});

// ── GET /api/v1/benchmarks/contracts/:address/optimizations ───────────────────

describe('GET /api/v1/benchmarks/contracts/:address/optimizations', () => {
  it('provides gas golfing recommendations', async () => {
    prismaReadMock.transaction.findMany.mockResolvedValue([
      { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '5000', sorobanResources: SOROBAN_RESOURCES },
      { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '3000', sorobanResources: SOROBAN_RESOURCES },
    ]);

    prismaReadMock.gasGolfingTip.findUnique.mockResolvedValue({
      id: '1',
      functionName: 'transfer',
      tips: ['Reduce event data emissions', 'Batch storage operations'],
    });

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/contracts/CAAAA/optimizations`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contractAddress).toBe('CAAAA');
    expect(body.optimizations).toHaveLength(1);
    expect(body.optimizations[0].tips.length).toBeGreaterThan(0);
    expect(body.optimizations[0].savingsPct).toBeGreaterThan(0);
    expect(body.optimizations[0].cheapestTx).toBeTruthy();
  });
});

// ── GET /api/v1/benchmarks/leaderboard ────────────────────────────────────────

describe('GET /api/v1/benchmarks/leaderboard', () => {
  it('returns efficiency leaderboard', async () => {
    prismaReadMock.transaction.findMany.mockResolvedValue([
      TX_FIXTURE,
      TX_FIXTURE_2,
    ]);

    prismaReadMock.contract.findMany.mockResolvedValue([
      { address: 'CAAAA', name: 'EfficientDEX' },
      { address: 'CBBBB', name: 'ExpensiveSwap' },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/leaderboard`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.byEfficiency).toBeDefined();
    expect(body.byFunction).toBeDefined();
  });
});

// ── GET /api/v1/benchmarks/leaderboard/gas-wasters ────────────────────────────

describe('GET /api/v1/benchmarks/leaderboard/gas-wasters', () => {
  it('returns most expensive contracts sorted by avg fee', async () => {
    prismaReadMock.transaction.findMany.mockResolvedValue([
      TX_FIXTURE,
      TX_FIXTURE_2,
    ]);

    prismaReadMock.contract.findMany.mockResolvedValue([
      { address: 'CAAAA', name: 'Cheap' },
      { address: 'CBBBB', name: 'Expensive' },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/leaderboard/gas-wasters`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.length).toBe(2);
    expect(body[0].avgCpu).toBeGreaterThanOrEqual(body[1].avgCpu);
  });
});

// ── GET /api/v1/benchmarks/compliance/:address ────────────────────────────────

describe('GET /api/v1/benchmarks/compliance/:address', () => {
  it('checks SEP-41 token compliance', async () => {
    prismaReadMock.contract.findUnique.mockResolvedValue({ address: 'CAAAA', isToken: true });

    prismaReadMock.standardCompliance.findMany.mockResolvedValue([
      {
        id: '1',
        contractType: 'sep-41',
        functionName: 'transfer',
        maxCpu: 100000,
        maxMemory: 500000,
        maxFeeStroops: BigInt(10000),
        description: 'SEP-41 token transfer expected range',
      },
    ]);

    prismaReadMock.transaction.findMany.mockResolvedValue([
      { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '5000', sorobanResources: SOROBAN_RESOURCES },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/compliance/CAAAA`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contractAddress).toBe('CAAAA');
    expect(body.contractType).toBe('sep-41');
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0].compliant).toBe(true);
    expect(body.checks[0].label).toContain('within range');
  });

  it('flags non-compliant contracts', async () => {
    prismaReadMock.contract.findUnique.mockResolvedValue({ address: 'CAAAA', isToken: true });

    prismaReadMock.standardCompliance.findMany.mockResolvedValue([
      {
        id: '1',
        contractType: 'sep-41',
        functionName: 'transfer',
        maxCpu: 100000,
        maxMemory: 500000,
        maxFeeStroops: BigInt(2000),
        description: 'SEP-41 token transfer expected range',
      },
    ]);

    prismaReadMock.transaction.findMany.mockResolvedValue([
      { ...TX_FIXTURE, functionName: 'transfer', feeCharged: '5000', sorobanResources: SOROBAN_RESOURCES },
    ]);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/compliance/CAAAA`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.checks[0].compliant).toBe(false);
    expect(body.checks[0].label).toContain('inefficiency');
  });

  it('returns 404 for unknown contract', async () => {
    prismaReadMock.contract.findUnique.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/v1/benchmarks/compliance/CUNKNOWN`);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('Contract not found');
  });
});
