/**
 * Integration tests for the Emergency management routers mount (#847).
 *
 * These tests verify that emergency sub-routers are properly accessible at their expected mounts:
 *   1. /emergency/incidents — incident management
 *   2. /emergency/alerts — alert configurations
 *   3. /emergency/protocol-health — protocol health status
 *   4. /emergency/analysis — historical analysis & reports
 *   5. /emergency/visualizations — visualizations & exports
 *
 * This test suite ensures that all sub-routers defined in emergency-router.ts
 * are mounted and handling requests correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    emergencyState: { findMany: vi.fn() },
    pauseEvent: { findMany: vi.fn(), count: vi.fn() },
    incidentReport: { count: vi.fn() },
    contract: { findMany: vi.fn() },
  },
  prismaWrite: {},
}));

vi.mock('../../src/indexer/emergency-indexer', () => ({
  classifyRisk: vi.fn((score: number) => (score > 7 ? 'critical' : 'warning')),
  computeDecentralizationScore: vi.fn(() => 8.5),
}));

vi.mock('../../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Imports (must come after vi.mock) ────────────────────────────────────────

import { prismaRead } from '../../src/db';
import { emergencyBaseRouter } from '../../src/api/emergency-router';

// ── App factory ──────────────────────────────────────────────────────────────

function makeEmergencyApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/emergency', emergencyBaseRouter);
  return app;
}

// Typed shortcuts for mocks
const mockRead = prismaRead as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Emergency management routers mount (#847)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts /emergency/overview and returns 200', async () => {
    mockRead['emergencyState']['findMany'].mockResolvedValueOnce([]);
    mockRead['pauseEvent']['count'].mockResolvedValueOnce(0);
    mockRead['pauseEvent']['findMany'].mockResolvedValueOnce([]);
    mockRead['incidentReport']['count'].mockResolvedValueOnce(0);
    mockRead['contract']['findMany'].mockResolvedValueOnce([]);

    const res = await request(makeEmergencyApp()).get('/emergency/overview');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pausedContracts');
  });

  it('mounts /emergency/incidents — sub-router is reachable', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/incidents');

    // Either 200 (mounted) or 404 with error != "Cannot GET /emergency/incidents"
    // A 404 from the sub-router is OK; missing mount gives generic 404
    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/alerts — sub-router is reachable', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/alerts');

    // Either 200/400/500 or 404 from the sub-router; not "cannot GET"
    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/protocol-health — sub-router is reachable', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/protocol-health');

    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/analysis — sub-router is reachable', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/analysis');

    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/visualizations — sub-router is reachable', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/visualizations');

    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/reports as alias for /analysis', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/reports');

    expect(res.status).not.toBe(404);
  });

  it('mounts /emergency/export as alias for /visualizations', async () => {
    const res = await request(makeEmergencyApp()).get('/emergency/export');

    expect(res.status).not.toBe(404);
  });
});
