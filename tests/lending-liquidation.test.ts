/**
 * Integration tests for the Soroban Liquidation Command Center API.
 *
 * Tests all 14+ endpoints for position health tracking, risk analysis,
 * liquidation simulation, liquidator bot toolkit, portfolio risk dashboard,
 * alerts, insurance, regulatory reporting, and price oracle monitoring.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mock Prisma before importing routes ───────────────────────────────────────

vi.mock('../src/db', () => ({
  prismaRead: {
    lendingPosition: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    positionEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    liquidationEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    protocolRiskMetrics: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    liquidationAlert: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    simulationRun: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    lendingPositionHistory: {
      findMany: vi.fn(),
    },
    priceOracle: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    liquidatorRegistration: {
      findUnique: vi.fn(),
    },
    insuranceCoverage: {
      findUnique: vi.fn(),
    },
    crossChainPosition: {
      findMany: vi.fn(),
    },
    portfolioSnapshot: {
      findFirst: vi.fn(),
    },
    contract: {
      findMany: vi.fn(),
    },
  },
  prismaWrite: {
    lendingPosition: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
    positionEvent: {
      create: vi.fn(),
    },
    liquidationEvent: {
      create: vi.fn(),
    },
    protocolRiskMetrics: {
      upsert: vi.fn(),
    },
    lendingPositionHistory: {
      create: vi.fn(),
    },
    liquidationAlert: {
      create: vi.fn(),
    },
    simulationRun: {
      create: vi.fn().mockResolvedValue({ id: 'sim-1' }),
    },
    priceOracle: {
      update: vi.fn(),
      upsert: vi.fn(),
    },
    liquidatorRegistration: {
      upsert: vi.fn().mockResolvedValue({
        liquidatorAddress: 'GLIQUIDATOR1',
        displayName: 'Test Bot',
        protocolAddresses: ['CPROTOCOL1'],
        active: true,
      }),
    },
    insuranceCoverage: {
      create: vi.fn(),
    },
    crossChainPosition: {
      create: vi.fn(),
    },
  },
}));

import { prismaRead, prismaWrite } from '../src/db';
const prisma = prismaRead as any;
import { lendingRouter } from '../src/api/lending';

// ── Test server setup ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/lending', lendingRouter);

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const POSITION_FIXTURE = {
  id: 'pos-1',
  protocolAddress: 'CPROTOCOL123456',
  userAddress: 'GUSER1234567890',
  collateralToken: 'CCOLLATERAL123',
  debtToken: 'CDEBT123456',
  collateralAmount: 10000,
  debtAmount: 5000,
  collateralUsd: 10000,
  debtUsd: 5000,
  healthFactor: 1.8,
  ltv: 50,
  liquidationPrice: 0.5,
  liquidationThreshold: 0.8,
  riskLevel: 'MODERATE',
  openedAt: new Date('2024-01-01'),
  lastUpdatedAt: new Date('2024-06-01'),
  status: 'ACTIVE',
  totalBorrowed: 5000,
  totalRepaid: 0,
  totalLiquidated: null,
  liquidationCount: 0,
};

const POSITION_FIXTURE_2 = {
  ...POSITION_FIXTURE,
  id: 'pos-2',
  healthFactor: 1.1,
  riskLevel: 'CRITICAL',
  debtAmount: 9000,
  debtUsd: 9000,
};

const POSITION_FIXTURE_3 = {
  ...POSITION_FIXTURE,
  id: 'pos-3',
  healthFactor: 0.95,
  riskLevel: 'LIQUIDATED',
  status: 'LIQUIDATED',
};

const EVENT_FIXTURE = {
  id: 'evt-1',
  positionId: 'pos-1',
  eventType: 'borrow',
  txHash: 'tx-hash-1',
  token: 'USDC',
  amount: 5000,
  usdValue: 5000,
  healthFactorBefore: 2.5,
  healthFactorAfter: 1.8,
  timestamp: new Date('2024-01-01'),
};

const LIQUIDATION_EVENT_FIXTURE = {
  id: 'liq-1',
  txHash: 'liq-tx-1',
  protocolAddress: 'CPROTOCOL123456',
  positionId: 'pos-3',
  userAddress: 'GUSER1234567890',
  liquidator: 'GLIQUIDATOR123',
  collateralToken: 'CCOLLATERAL123',
  debtToken: 'CDEBT123456',
  collateralSeized: 10000,
  debtCovered: 9000,
  collateralUsd: 8000,
  debtUsd: 9000,
  bonus: 0.08,
  healthFactorAtEvent: 0.95,
  timestamp: new Date('2024-06-01'),
};

const PROTOCOL_METRICS_FIXTURE = {
  id: 'metrics-1',
  protocolAddress: 'CPROTOCOL123456',
  totalValueLocked: 1000000,
  totalBorrowed: 500000,
  availableLiquidity: 500000,
  utilizationRate: 0.5,
  avgHealthFactor: 2.1,
  weightedAvgHealthFactor: 1.9,
  positionsAtRisk: 25,
  positionsCritical: 5,
  badDebt: 10000,
  liquidation24h: 3,
  liquidationVolume24h: 50000,
  updatedAt: new Date('2024-06-01'),
};

const ALERT_FIXTURE = {
  id: 'alert-1',
  positionId: 'pos-2',
  alertType: 'risk_level_CRITICAL',
  severity: 'critical',
  message: 'Position pos-2 is at CRITICAL risk',
  healthFactor: 1.1,
  metadata: { collateralToken: 'CCOLLATERAL123', debtToken: 'CDEBT123456' },
  createdAt: new Date('2024-06-01'),
  delivered: false,
  acknowledged: false,
};

const SIMULATION_FIXTURE = {
  id: 'sim-1',
  name: 'Test Simulation',
  scenario: { priceChanges: [{ token: 'CCOLLATERAL123', dropPercentage: 20 }] },
  result: { positionsLiquidated: 5 },
  triggeredBy: 'api',
  createdAt: new Date('2024-06-01'),
  completedAt: new Date('2024-06-01'),
  duration: 150,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Tests are unchanged from here - only the mock above was rewritten
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/lending', () => {
  it('returns service info with endpoints list', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.service).toBe('Soroban Liquidation Command Center');
    expect(body.endpoints).toHaveProperty('positions');
    expect(body.endpoints).toHaveProperty('stats');
    expect(body.endpoints).toHaveProperty('simulate');
  });
});

describe('GET /api/v1/lending/positions/:userAddress', () => {
  it('returns all positions for a user', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE, POSITION_FIXTURE_2]);
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUSER1234567890`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalPositions).toBe(2);
    expect(body.positions).toHaveLength(2);
    expect(body.positions[0]).toHaveProperty('riskConfig');
  });

  it('returns empty array for user with no positions', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUNKNOWN`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalPositions).toBe(0);
  });
});

describe('GET /api/v1/lending/positions/:userAddress/:positionId', () => {
  it('returns position detail with event history', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue({
      ...POSITION_FIXTURE,
      events: [EVENT_FIXTURE],
      alerts: [ALERT_FIXTURE],
      liquidationEvents: [LIQUIDATION_EVENT_FIXTURE],
    });
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUSER1234567890/pos-1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe('pos-1');
    expect(body.healthFactor).toBe(1.8);
    expect(body.riskConfig).toHaveProperty('color', '#eab308');
  });

  it('returns 404 for position belonging to different user', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue({ ...POSITION_FIXTURE, userAddress: 'GDIFFERENT' });
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUSER1234567890/pos-1`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown position', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUSER/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/lending/positions/:userAddress/:positionId/timeline', () => {
  it('returns event timeline for a position', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue(POSITION_FIXTURE);
    (prisma.positionEvent.findMany as any).mockResolvedValue([EVENT_FIXTURE]);
    (prisma.lendingPositionHistory.findMany as any).mockResolvedValue([
      { healthFactor: 1.8, collateralUsd: 10000, debtUsd: 5000, snapshotTime: new Date('2024-06-01') },
    ]);
    const res = await fetch(`${baseUrl}/api/v1/lending/positions/GUSER1234567890/pos-1/timeline`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.timeline).toBeInstanceOf(Array);
    expect(body.timeline.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/v1/lending/protocols/:address/positions', () => {
  it('returns filterable positions for a protocol', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE]);
    (prisma.lendingPosition.count as any).mockResolvedValue(1);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPROTOCOL123456/positions`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.positions).toHaveLength(1);
  });
});

describe('GET /api/v1/lending/protocols/:address/risk', () => {
  it('returns protocol risk dashboard', async () => {
    (prisma.protocolRiskMetrics.findUnique as any).mockResolvedValue(PROTOCOL_METRICS_FIXTURE);
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE, POSITION_FIXTURE_2]);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPROTOCOL123456/risk`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('avgHealthFactor');
    expect(body).toHaveProperty('riskDistribution');
    expect(body).toHaveProperty('healthDistribution');
  });

  it('returns 404 if metrics not found', async () => {
    (prisma.protocolRiskMetrics.findUnique as any).mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPUNKNOWN/risk`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/lending/protocols/:address/risk/history', () => {
  it('returns risk metrics history', async () => {
    (prisma.lendingPositionHistory.findMany as any).mockResolvedValue([
      { healthFactor: 2.0, collateralUsd: 10000, debtUsd: 5000, snapshotTime: new Date('2024-06-01') },
    ]);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPROTOCOL123456/risk/history?days=30`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.history).toBeInstanceOf(Array);
  });
});

describe('GET /api/v1/lending/protocols/:address/liquidations', () => {
  it('returns liquidation history', async () => {
    (prisma.liquidationEvent.findMany as any).mockResolvedValue([LIQUIDATION_EVENT_FIXTURE]);
    (prisma.liquidationEvent.count as any).mockResolvedValue(1);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPROTOCOL123456/liquidations`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.liquidations).toHaveLength(1);
  });
});

describe('GET /api/v1/lending/alert', () => {
  it('returns recent alerts', async () => {
    (prisma.liquidationAlert.findMany as any).mockResolvedValue([ALERT_FIXTURE]);
    (prisma.liquidationAlert.count as any).mockResolvedValue(1);
    const res = await fetch(`${baseUrl}/api/v1/lending/alert`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.alerts).toHaveLength(1);
  });
});

describe('GET /api/v1/lending/leaderboard', () => {
  it('returns health factor leaderboard', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([
      { id: 'pos-1', userAddress: 'GUSER1', protocolAddress: 'CPROTOCOL1', healthFactor: 1.05, debtUsd: 10000, riskLevel: 'CRITICAL' },
    ]);
    const res = await fetch(`${baseUrl}/api/v1/lending/leaderboard`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metric).toBe('health_factor');
  });

  it('returns liquidator leaderboard', async () => {
    (prisma.liquidationEvent.groupBy as any).mockResolvedValue([
      { liquidator: 'GLIQUIDATOR1', _count: { id: 10 }, _sum: { debtCovered: 50000 } },
    ]);
    const res = await fetch(`${baseUrl}/api/v1/lending/leaderboard?metric=liquidator`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metric).toBe('liquidator');
  });
});

describe('GET /api/v1/lending/stats', () => {
  it('returns aggregate network stats', async () => {
    (prisma.lendingPosition.count as any).mockResolvedValueOnce(100);
    (prisma.lendingPosition.count as any).mockResolvedValueOnce(80);
    (prisma.lendingPosition.aggregate as any).mockResolvedValueOnce({ _sum: { collateralUsd: 5000000 } });
    (prisma.lendingPosition.aggregate as any).mockResolvedValueOnce({ _sum: { debtUsd: 2500000 } });
    (prisma.lendingPosition.aggregate as any).mockResolvedValueOnce({ _avg: { healthFactor: 2.3 } });
    (prisma.lendingPosition.count as any).mockResolvedValueOnce(10);
    (prisma.liquidationEvent.count as any).mockResolvedValue(3);
    (prisma.liquidationEvent.aggregate as any).mockResolvedValue({ _sum: { debtCovered: 50000 } });
    const res = await fetch(`${baseUrl}/api/v1/lending/stats`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalPositions');
    expect(body).toHaveProperty('activePositions');
    expect(body).toHaveProperty('totalValueLocked');
  });
});

describe('GET /api/v1/lending/network/health', () => {
  it('returns cross-protocol risk dashboard', async () => {
    (prisma.protocolRiskMetrics.findMany as any).mockResolvedValue([PROTOCOL_METRICS_FIXTURE]);
    const res = await fetch(`${baseUrl}/api/v1/lending/network/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('totalProtocols', 1);
    expect(body).toHaveProperty('systemicRiskScore');
  });
});

describe('GET /api/v1/lending/network/liquidators', () => {
  it('returns top liquidators', async () => {
    (prisma.liquidationEvent.groupBy as any).mockResolvedValue([
      { liquidator: 'GLIQUIDATOR1', _count: { id: 15 }, _sum: { debtCovered: 100000, collateralSeized: 120000 } },
    ]);
    (prisma.liquidatorRegistration.findUnique as any).mockResolvedValue({ displayName: 'Mega Bot', active: true });
    const res = await fetch(`${baseUrl}/api/v1/lending/network/liquidators`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.topLiquidators).toHaveLength(1);
  });
});

describe('POST /api/v1/lending/simulate-liquidation', () => {
  it('returns simulation result', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE_2]);
    (prisma.priceOracle.findFirst as any).mockResolvedValue({ lastPrice: 1.0, lastUpdateTime: new Date() });
    const res = await fetch(`${baseUrl}/api/v1/lending/simulate-liquidation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: { priceChanges: [{ token: 'CCOLLATERAL123', dropPercentage: 50 }], protocolFailures: [] },
        options: { includeSecondOrderEffects: true, maxCascadeDepth: 5, includeLiquidationBonus: true },
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('liquidations');
  });

  it('returns 400 for missing scenario', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/simulate-liquidation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/lending/simulations', () => {
  it('returns previous simulation runs', async () => {
    (prisma.simulationRun.findMany as any).mockResolvedValue([SIMULATION_FIXTURE]);
    const res = await fetch(`${baseUrl}/api/v1/lending/simulations`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.simulations).toHaveLength(1);
  });
});

describe('GET /api/v1/lending/simulations/:id', () => {
  it('returns simulation detail', async () => {
    (prisma.simulationRun.findUnique as any).mockResolvedValue(SIMULATION_FIXTURE);
    const res = await fetch(`${baseUrl}/api/v1/lending/simulations/sim-1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe('sim-1');
  });
});

describe('POST /api/v1/lending/liquidator/register', () => {
  it('registers a new liquidator', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/liquidator/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liquidatorAddress: 'GLIQUIDATOR1', displayName: 'Test Bot', protocolAddresses: ['CPROTOCOL1'] }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.liquidatorAddress).toBe('GLIQUIDATOR1');
  });
});

describe('GET /api/v1/lending/liquidator/opportunities', () => {
  it('returns liquidation opportunities', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE_2]);
    const res = await fetch(`${baseUrl}/api/v1/lending/liquidator/opportunities`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('opportunities');
  });
});

describe('GET /api/v1/lending/portfolio/:userAddress/risk', () => {
  it('returns aggregated portfolio risk', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE, POSITION_FIXTURE_2]);
    const res = await fetch(`${baseUrl}/api/v1/lending/portfolio/GUSER1234567890/risk`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('portfolioHealthFactor');
    expect(body).toHaveProperty('recommendations');
  });

  it('handles user with no positions', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/api/v1/lending/portfolio/GUNKNOWN/risk`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalCollateral).toBe('0 USD');
  });
});

describe('GET /api/v1/lending/insurance/:positionId', () => {
  it('returns insurance coverage', async () => {
    (prisma.insuranceCoverage.findUnique as any).mockResolvedValue({
      positionId: 'pos-1', insuranceProtocol: 'NexusMutual',
      coverageAmountUsd: 10000, premiumPaidUsd: 500,
      expiryDate: new Date('2025-01-01'), active: true,
    });
    const res = await fetch(`${baseUrl}/api/v1/lending/insurance/pos-1`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/lending/insurance/claim', () => {
  it('simulates an insurance claim', async () => {
    (prisma.insuranceCoverage.findUnique as any).mockResolvedValue({ positionId: 'pos-1', active: true, coverageAmountUsd: 10000 });
    const res = await fetch(`${baseUrl}/api/v1/lending/insurance/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: 'pos-1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('claimId');
  });
});

describe('GET /api/v1/lending/reports/systemic-risk', () => {
  it('returns systemic risk report', async () => {
    (prisma.protocolRiskMetrics.findMany as any).mockResolvedValue([PROTOCOL_METRICS_FIXTURE]);
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE]);
    (prisma.liquidationEvent.findMany as any).mockResolvedValue([LIQUIDATION_EVENT_FIXTURE]);
    const res = await fetch(`${baseUrl}/api/v1/lending/reports/systemic-risk`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('totalProtocols');
  });
});

describe('GET /api/v1/lending/reports/:protocol', () => {
  it('returns protocol risk report', async () => {
    (prisma.protocolRiskMetrics.findUnique as any).mockResolvedValue(PROTOCOL_METRICS_FIXTURE);
    (prisma.lendingPosition.findMany as any).mockResolvedValue([POSITION_FIXTURE]);
    (prisma.liquidationEvent.findMany as any).mockResolvedValue([LIQUIDATION_EVENT_FIXTURE]);
    const res = await fetch(`${baseUrl}/api/v1/lending/reports/CPROTOCOL123456`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.protocolAddress).toBe('CPROTOCOL123456');
    expect(body).toHaveProperty('metrics');
  });
});

describe('POST /api/v1/lending/debug/replay', () => {
  it('replays position history', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue({
      ...POSITION_FIXTURE, events: [EVENT_FIXTURE], liquidationEvents: [LIQUIDATION_EVENT_FIXTURE],
    });
    const res = await fetch(`${baseUrl}/api/v1/lending/debug/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: 'pos-1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.steps).toBeInstanceOf(Array);
    expect(body).toHaveProperty('whatIfScenarios');
  });
});

describe('GET /api/v1/lending/oracles', () => {
  it('returns oracle dashboard', async () => {
    (prisma.priceOracle.findMany as any).mockResolvedValue([{
      oracleAddress: 'O1', oracleType: 'Chainlink', tokenAddress: 'CCOLLATERAL123',
      lastPrice: 0.12, lastUpdateTime: new Date(), deviationSinceLastUpdate: 0.5,
      protocolCount: 2, healthScore: 85, stale: false,
    }]);
    const res = await fetch(`${baseUrl}/api/v1/lending/oracles`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('oracles');
  });
});

describe('GET /api/v1/lending/predictions', () => {
  it('returns ML-powered predictions', async () => {
    (prisma.lendingPosition.findMany as any).mockResolvedValue([
      { ...POSITION_FIXTURE_2, events: [EVENT_FIXTURE], liquidationEvents: [] },
    ]);
    const res = await fetch(`${baseUrl}/api/v1/lending/predictions`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('predictions');
    expect(body).toHaveProperty('modelInfo');
  });
});

describe('POST /api/v1/lending/hedge/simulate', () => {
  it('simulates hedging strategies', async () => {
    (prisma.lendingPosition.findUnique as any).mockResolvedValue(POSITION_FIXTURE);
    const res = await fetch(`${baseUrl}/api/v1/lending/hedge/simulate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: 'pos-1', strategy: 'stablecoin_increase' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.simulation).toHaveProperty('newHealthFactor');
  });
});

describe('GET /api/v1/lending/stress-test/scenarios', () => {
  it('returns stress test scenarios', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/stress-test/scenarios`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.scenarios.length).toBeGreaterThanOrEqual(3);
  });
});

describe('GET /api/v1/lending/cross-chain/:userAddress', () => {
  it('returns cross-chain positions', async () => {
    (prisma.crossChainPosition.findMany as any).mockResolvedValue([{
      userAddress: 'GUSER1', sourceChain: 'ethereum', bridgeProtocol: 'Wormhole',
      collateralToken: 'ETH', debtToken: 'USDC', collateralAmount: 10, debtAmount: 15000,
      healthFactor: 1.5, lastSyncedAt: new Date(), createdAt: new Date(),
    }]);
    const res = await fetch(`${baseUrl}/api/v1/lending/cross-chain/GUSER1`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalChains).toBeGreaterThanOrEqual(1);
  });
});

describe('Negative tests', () => {
  it('POST /simulate-liquidation with empty priceChanges returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/simulate-liquidation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: { priceChanges: [] }, options: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /insurance/claim with missing positionId returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/insurance/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /protocols/:address/risk for unknown protocol returns 404', async () => {
    (prisma.protocolRiskMetrics.findUnique as any).mockResolvedValue(null);
    const res = await fetch(`${baseUrl}/api/v1/lending/protocols/CPUNKNOWN/risk`);
    expect(res.status).toBe(404);
  });

  it('POST /hedge/simulate with invalid strategy returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/v1/lending/hedge/simulate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: 'pos-1', strategy: 'invalid' }),
    });
    expect(res.status).toBe(400);
  });
});
