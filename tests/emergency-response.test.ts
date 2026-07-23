import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// requireRoleMw is hoisted so the route-captured middleware delegates through it.
const { requireRoleMw } = vi.hoisted(() => ({
  requireRoleMw: vi.fn(
    (
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => unknown } },
      _next: () => void,
    ) => res.status(403).json({ error: 'Insufficient role' }),
  ),
}));

vi.mock('../src/db', () => ({
  prismaRead: {
    emergencyState: { findMany: vi.fn(), findUnique: vi.fn() },
    pauseEvent: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    incidentReport: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    incidentComment: { findMany: vi.fn(), create: vi.fn() },
    alertConfiguration: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    protocolHealthScore: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    pauserAnalysis: { findMany: vi.fn() },
    recoveryAnalysis: { findMany: vi.fn() },
    contract: { findMany: vi.fn().mockResolvedValue([]) },
    authSession: { findFirst: vi.fn() },
    walletUser: { findUnique: vi.fn() },
  },
  prismaWrite: {
    incidentReport: { create: vi.fn(), update: vi.fn() },
    incidentComment: { create: vi.fn() },
    alertConfiguration: { create: vi.fn(), update: vi.fn() },
    authSession: { update: vi.fn() },
  },
}));

vi.mock('../src/indexer/emergency-indexer', () => ({
  classifyRisk: vi.fn(() => ({ level: 'low', score: 0.1 })),
  computeDecentralizationScore: vi.fn(() => 0.8),
}));

vi.mock('../src/middleware/sanitize', () => ({
  validateAddressParam: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Real requireAuth / requireRole so we can test auth enforcement
vi.mock('../src/auth/middleware', () => ({
  requireAuth: vi.fn(
    (
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => unknown } },
      _next: () => void,
    ) => {
      // Default: reject (no token). Individual tests override as needed.
      return res.status(401).json({ error: 'Authentication required' });
    },
  ),
  // Returns the hoisted requireRoleMw so route-captured middleware is controllable.
  requireRole: vi.fn(() => requireRoleMw),
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { prismaRead, prismaWrite } from '../src/db';
import { requireAuth } from '../src/auth/middleware';
import { emergencyBaseRouter } from '../src/api/emergency-router';

// ── Test server ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/emergency', emergencyBaseRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default deny behaviors after clearAllMocks resets them.
  (requireAuth as ReturnType<typeof vi.fn>).mockImplementation(
    (
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => unknown } },
      _next: () => void,
    ) => res.status(401).json({ error: 'Authentication required' }),
  );
  requireRoleMw.mockImplementation(
    (
      _req: unknown,
      res: { status: (n: number) => { json: (b: unknown) => unknown } },
      _next: () => void,
    ) => res.status(403).json({ error: 'Insufficient role' }),
  );
});

// ── Read-only endpoints (no auth required) ────────────────────────────────────

describe('GET /api/v1/emergency/overview', () => {
  it('returns 200 without auth', async () => {
    (prismaRead.emergencyState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.pauseEvent.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (prismaRead.pauseEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.incidentReport.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/api/v1/emergency/overview`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/emergency/incidents', () => {
  it('returns 200 without auth', async () => {
    (prismaRead.incidentReport.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prismaRead.incidentReport.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const res = await fetch(`${baseUrl}/api/v1/emergency/incidents`);
    expect(res.status).toBe(200);
  });
});

// ── State-changing endpoints require admin role ───────────────────────────────

describe('POST /api/v1/emergency/incidents — auth enforcement', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/v1/emergency/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractAddress: 'CABC123', severity: 'high', title: 'Test' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 201 when admin token is provided', async () => {
    // Make requireAuth and requireRoleMw pass for this test
    (requireAuth as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_req: unknown, _res: unknown, next: () => void) => next(),
    );
    requireRoleMw.mockImplementationOnce((_req: unknown, _res: unknown, next: () => void) =>
      next(),
    );
    (prismaWrite.incidentReport.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'inc-1',
      contractAddress: 'CABC123',
      severity: 'high',
      title: 'Test',
      status: 'open',
      createdAt: new Date(),
    });

    const res = await fetch(`${baseUrl}/api/v1/emergency/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: JSON.stringify({ contractAddress: 'CABC123', severity: 'high', title: 'Test' }),
    });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/v1/emergency/incidents/:id — auth enforcement', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/v1/emergency/incidents/inc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'investigating' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/emergency/incidents/:id/resolve — auth enforcement', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/v1/emergency/incidents/inc-1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/emergency/alerts — auth enforcement', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/v1/emergency/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-1',
        alertType: 'pause_detected',
        channels: [{ type: 'webhook', config: { url: 'https://example.com' } }],
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/emergency/alerts/:id — auth enforcement', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/v1/emergency/alerts/alert-1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });
});

// ── Protocol health (read-only) ───────────────────────────────────────────────

describe('GET /api/v1/emergency/protocol-health', () => {
  it('returns 200 without auth', async () => {
    (prismaRead.protocolHealthScore.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/api/v1/emergency/protocol-health`);
    expect(res.status).toBe(200);
  });
});
