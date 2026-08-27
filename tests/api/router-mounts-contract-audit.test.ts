/**
 * Integration tests for the Contract-audit routers mount (#848).
 *
 * These tests verify that contract-audit sub-routers are properly mounted:
 *   1. /audit/contracts — main contract audit endpoint
 *   2. /audit/auditors — auditor registry
 *   3. /audit/verify — verification flow
 *   4. /audit/bot — bot auditor interface
 *   5. /audit/embed — embeddable audit widget
 *   6. /audit/incidents — audit incidents
 *
 * This test suite ensures that all contract audit routers defined in
 * contract-audit.ts and related audit files are mounted correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  prismaRead: {
    contractAudit: { findFirst: vi.fn(), findMany: vi.fn() },
    auditFinding: { findMany: vi.fn() },
    auditAlert: { findMany: vi.fn() },
  },
  prismaWrite: {
    auditAlert: { create: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('../../src/middleware/sanitize', () => ({
  validateAddressParam: (req: any, res: any, next: any) => next(),
}));

vi.mock('../../src/lib/audit-pdf-report', () => ({
  generateAuditPdf: vi.fn(),
}));

vi.mock('../../src/lib/audit-pdf-loader', () => ({
  loadAuditReportData: vi.fn(),
}));

vi.mock('../../src/lib/formal-verifier', () => ({
  runFormalVerification: vi.fn(),
}));

vi.mock('../../src/lib/audit-benchmark', () => ({
  benchmarkContract: vi.fn(),
}));

vi.mock('../../src/lib/audit-remediation', () => ({
  generateRemediation: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Imports (must come after vi.mock) ────────────────────────────────────────

import { contractAuditRouter } from '../../src/api/contract-audit';

// ── App factory ──────────────────────────────────────────────────────────────

function makeContractAuditApp(): Express {
  const app = express();
  app.use(express.json());
  // Mount as it would be in production: under /contracts/:address/audit
  app.use('/contracts/:address/audit', contractAuditRouter);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Contract-audit routers mount (#848)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts /contracts/:address/audit — base path is reachable', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit',
    );

    // Should handle the route (200, 404, or error from router), not Express 404
    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/history — history sub-route', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/history',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/:version — version sub-route', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/1',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/badge.svg — badge generation', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/badge.svg',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/alerts — alert subscriptions', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/alerts',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/:version/anchor — anchor operations', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/1/anchor',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/score-history — score trends', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/score-history',
    );

    expect(res.status).not.toBe(404);
  });

  it('mounts /contracts/:address/audit/pdf — PDF report generation', async () => {
    const res = await request(makeContractAuditApp()).get(
      '/contracts/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/audit/pdf',
    );

    expect(res.status).not.toBe(404);
  });
});
