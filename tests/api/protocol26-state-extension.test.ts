/**
 * Unit tests for Protocol 26 State Extension API Router
 *
 * Tests the POST /contracts/:contractId/extend-ttl endpoint which now performs
 * a real Soroban RPC simulateTransaction call (fix for issue #636).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/indexer/rpc', () => ({
  rpc: {
    simulateTransaction: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    stellarRpcUrl: 'http://localhost:8000',
    profile: { name: 'testnet' },
  },
}));

// We need to mock @stellar/stellar-sdk's SorobanRpc.Api helpers
// because they are used to check simulation result types
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Api: {
        isSimulationSuccess: vi.fn(),
        isSimulationRestore: vi.fn(),
      },
    },
  };
});

import { protocol26Router } from '../../src/api/protocol26-state-extension';
import { rpc } from '../../src/indexer/rpc';
import { SorobanRpc } from '@stellar/stellar-sdk';

// ── Test app setup ────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/protocol26', protocol26Router);
  return app;
}

// ── Test data ─────────────────────────────────────────────────────────────────

const VALID_CONTRACT_ID = '0000000000000000000000000000000000000000000000000000000000000001';
const VALID_PAYLOAD = {
  contractId: VALID_CONTRACT_ID,
  ledgersToLive: 1000,
  entryType: 'instance',
};

const SUCCESS_SIMULATION_RESULT = {
  cost: {
    cpuInsns: '100000',
    memBytes: '50000',
  },
  minResourceFee: '1000000',
  transactionData: {
    toXDR: vi.fn().mockReturnValue('AAAAAgAAAABhZf7...'),
  },
  result: {
    retval: {
      toXDR: vi.fn().mockReturnValue('AAAAAA=='),
    },
    auth: [],
  },
  events: [],
};

const RESTORE_SIMULATION_RESULT = {
  cost: {
    cpuInsns: '50000',
    memBytes: '20000',
  },
  minResourceFee: '500000',
  transactionData: {
    toXDR: vi.fn().mockReturnValue('AAAAAgAAAABhZf7...'),
  },
  result: {
    retval: null,
    auth: [],
  },
  events: [],
};

const ERROR_SIMULATION_RESULT = {
  error: 'HostError: Value was not found in ledger',
  events: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Protocol 26 State Extension Router', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ── GET / ─────────────────────────────────────────────────────────────────

  describe('GET /protocol26', () => {
    it('returns 200 with service info', async () => {
      const res = await request(app).get('/protocol26');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('protocol', 26);
      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('features');
      expect(res.body).toHaveProperty('endpoints');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });
  });

  // ── GET /contracts/:contractId/ttl ────────────────────────────────────────

  describe('GET /protocol26/contracts/:contractId/ttl', () => {
    it('returns 200 with TTL info', async () => {
      const res = await request(app).get(
        `/protocol26/contracts/${VALID_CONTRACT_ID}/ttl`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('contractId', VALID_CONTRACT_ID);
      expect(res.body).toHaveProperty('currentLedger');
      expect(res.body).toHaveProperty('entries');
      expect(res.body).toHaveProperty('archivalPolicy');
    });
  });

  // ── POST /contracts/:contractId/extend-ttl ────────────────────────────────

  describe('POST /protocol26/contracts/:contractId/extend-ttl', () => {
    it('returns 400 when contractId is missing', async () => {
      const res = await request(app)
        .post('/protocol26/contracts//extend-ttl')
        .send({ ledgersToLive: 1000 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when ledgersToLive is missing', async () => {
      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ entryType: 'instance' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when ledgersToLive is out of range', async () => {
      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 9999999999, entryType: 'instance' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when entryType is invalid', async () => {
      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000, entryType: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when contractId is not valid hex', async () => {
      const res = await request(app)
        .post('/protocol26/contracts/INVALID_CONTRACT_ID/extend-ttl')
        .send({ ledgersToLive: 1000, entryType: 'instance' });
      expect(res.status).toBe(400);
    });

    it('returns 200 with success status when simulation succeeds', async () => {
      vi.mocked(SorobanRpc.Api.isSimulationSuccess).mockReturnValue(true);
      vi.mocked(SorobanRpc.Api.isSimulationRestore).mockReturnValue(false);
      vi.mocked(rpc.simulateTransaction).mockResolvedValue(
        SUCCESS_SIMULATION_RESULT as any,
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000, entryType: 'instance' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('contractId', VALID_CONTRACT_ID);
      expect(res.body).toHaveProperty('entryType', 'instance');
      expect(res.body).toHaveProperty('operation', 'extend_ttl');
      expect(res.body).toHaveProperty('ledgersExtended', 1000);
      expect(res.body).toHaveProperty('newLiveUntilLedger');
      expect(res.body).toHaveProperty('status', 'success');
      expect(res.body).toHaveProperty('simulation');
      expect(res.body.simulation).toHaveProperty('minResourceFee', '1000000');
      expect(res.body.simulation).toHaveProperty('cpuInstructions', 100000);
      expect(res.body.simulation).toHaveProperty('memoryBytes', 50000);
      expect(res.body.simulation).toHaveProperty('transactionXdr');
      expect(res.body).toHaveProperty('estimatedFeeLumens');
      expect(res.body).toHaveProperty('note');
      expect(res.body).toHaveProperty('expiresAt');
      expect(res.body).toHaveProperty('submittedAt');
      expect(res.body).toHaveProperty('raw');

      // Verify the RPC was called
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 200 with success status for restore simulation', async () => {
      vi.mocked(SorobanRpc.Api.isSimulationSuccess).mockReturnValue(false);
      vi.mocked(SorobanRpc.Api.isSimulationRestore).mockReturnValue(true);
      vi.mocked(rpc.simulateTransaction).mockResolvedValue(
        RESTORE_SIMULATION_RESULT as any,
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 500, entryType: 'persistent' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'success');
      expect(res.body).toHaveProperty('entryType', 'persistent');
      expect(res.body).toHaveProperty('ledgersExtended', 500);
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 200 with success status for temporary entry type', async () => {
      vi.mocked(SorobanRpc.Api.isSimulationSuccess).mockReturnValue(true);
      vi.mocked(SorobanRpc.Api.isSimulationRestore).mockReturnValue(false);
      vi.mocked(rpc.simulateTransaction).mockResolvedValue(
        SUCCESS_SIMULATION_RESULT as any,
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 100, entryType: 'temporary' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'success');
      expect(res.body).toHaveProperty('entryType', 'temporary');
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 422 when simulation returns an error', async () => {
      vi.mocked(SorobanRpc.Api.isSimulationSuccess).mockReturnValue(false);
      vi.mocked(SorobanRpc.Api.isSimulationRestore).mockReturnValue(false);
      vi.mocked(rpc.simulateTransaction).mockResolvedValue(
        ERROR_SIMULATION_RESULT as any,
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000, entryType: 'instance' });

      expect(res.status).toBe(422);
      expect(res.body).toHaveProperty('status', 'failed');
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('diagnostics');
      expect(res.body.diagnostics).toHaveProperty('rpcError');
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 502 when RPC call fails with a network error', async () => {
      vi.mocked(rpc.simulateTransaction).mockRejectedValue(
        new Error('ECONNREFUSED: connection refused'),
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000, entryType: 'instance' });

      expect(res.status).toBe(502);
      expect(res.body).toHaveProperty('status', 'error');
      expect(res.body).toHaveProperty('error', 'RPC request failed');
      expect(res.body).toHaveProperty('detail');
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns 504 when RPC call times out', async () => {
      vi.mocked(rpc.simulateTransaction).mockRejectedValue(
        new Error('Simulation timed out after 10000ms'),
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000, entryType: 'instance' });

      expect(res.status).toBe(504);
      expect(res.body).toHaveProperty('status', 'error');
      expect(res.body).toHaveProperty('error', 'Simulation timed out');
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('uses default entryType "instance" when not provided', async () => {
      vi.mocked(SorobanRpc.Api.isSimulationSuccess).mockReturnValue(true);
      vi.mocked(SorobanRpc.Api.isSimulationRestore).mockReturnValue(false);
      vi.mocked(rpc.simulateTransaction).mockResolvedValue(
        SUCCESS_SIMULATION_RESULT as any,
      );

      const res = await request(app)
        .post(`/protocol26/contracts/${VALID_CONTRACT_ID}/extend-ttl`)
        .send({ ledgersToLive: 1000 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entryType', 'instance');
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /contracts/:contractId/entries ────────────────────────────────────

  describe('GET /protocol26/contracts/:contractId/entries', () => {
    it('returns 200 with entries info', async () => {
      const res = await request(app).get(
        `/protocol26/contracts/${VALID_CONTRACT_ID}/entries`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('contractId', VALID_CONTRACT_ID);
      expect(res.body).toHaveProperty('filter');
      expect(res.body).toHaveProperty('entries');
      expect(res.body).toHaveProperty('total');
    });

    it('respects query parameters', async () => {
      const res = await request(app)
        .get(
          `/protocol26/contracts/${VALID_CONTRACT_ID}/entries?type=persistent&nearExpiry=true`,
        );
      expect(res.status).toBe(200);
      expect(res.body.filter).toHaveProperty('type', 'persistent');
      expect(res.body.filter).toHaveProperty('nearExpiry', true);
    });
  });

  // ── GET /archive/stats ────────────────────────────────────────────────────

  describe('GET /protocol26/archive/stats', () => {
    it('returns 200 with archive stats', async () => {
      const res = await request(app).get('/protocol26/archive/stats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalArchivedContracts');
      expect(res.body).toHaveProperty('totalArchivedEntries');
      expect(res.body).toHaveProperty('lastUpdated');
    });
  });

  // ── POST /footprint/optimize ──────────────────────────────────────────────

  describe('POST /protocol26/footprint/optimize', () => {
    it('returns 200 with optimized footprint', async () => {
      const res = await request(app)
        .post('/protocol26/footprint/optimize')
        .send({
          contractId: VALID_CONTRACT_ID,
          readOnly: ['key1', 'key2', 'key3'],
          readWrite: ['key2', 'key3', 'key4'],
        });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('contractId', VALID_CONTRACT_ID);
      expect(res.body).toHaveProperty('original');
      expect(res.body).toHaveProperty('optimized');
      expect(res.body).toHaveProperty('removedDuplicates', 2);
      expect(res.body).toHaveProperty('duplicateKeys', ['key2', 'key3']);
    });

    it('returns 400 when contractId is missing', async () => {
      const res = await request(app)
        .post('/protocol26/footprint/optimize')
        .send({ readOnly: [], readWrite: [] });
      expect(res.status).toBe(400);
    });

    it('handles empty arrays', async () => {
      const res = await request(app)
        .post('/protocol26/footprint/optimize')
        .send({
          contractId: VALID_CONTRACT_ID,
          readOnly: [],
          readWrite: [],
        });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('removedDuplicates', 0);
      expect(res.body).toHaveProperty('recommendation');
    });
  });

  // ── GET /expiring ─────────────────────────────────────────────────────────

  describe('GET /protocol26/expiring', () => {
    it('returns 200 with expiring contracts info', async () => {
      const res = await request(app).get('/protocol26/expiring');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('threshold');
      expect(res.body).toHaveProperty('thresholdDescription');
      expect(res.body).toHaveProperty('expiringContracts');
      expect(res.body).toHaveProperty('total');
    });

    it('respects ledgersThreshold query parameter', async () => {
      const res = await request(app).get(
        '/protocol26/expiring?ledgersThreshold=10000',
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('threshold', 10000);
    });

    it('caps threshold at 518400', async () => {
      const res = await request(app).get(
        '/protocol26/expiring?ledgersThreshold=999999',
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('threshold', 518400);
    });
  });
});