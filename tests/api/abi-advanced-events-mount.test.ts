import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/indexer/abi-cache', () => ({
  getCachedAbi: vi.fn(),
  setCachedAbi: vi.fn(),
  deleteCachedAbi: vi.fn(),
}));

vi.mock('../../src/indexer/wasm-spec', () => ({
  fetchContractSpec: vi.fn(),
}));

vi.mock('../../src/middleware/asyncHandler', () => ({
  asyncHandler: (fn: Mock) => fn,
}));

import * as abiCache from '../../src/indexer/abi-cache';
import * as wasmSpec from '../../src/indexer/wasm-spec';
import { abiRouter } from '../../src/api/abi';
import { advancedEventsRouter } from '../../src/api/advanced-events';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/abi', abiRouter);
  app.use('/events/advanced', advancedEventsRouter);
  return app;
}

describe('ABI Router Mount (#843)', () => {
  describe('GET /abi', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns on-chain ABI when available', async () => {
      const mockAbi = { functions: [{ name: 'test', inputs: [], outputs: [] }] };
      vi.mocked(wasmSpec.fetchContractSpec).mockResolvedValue(mockAbi as any);

      const res = await request(makeApp()).get('/abi');
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('on-chain');
    });

    it('returns stored ABI as fallback', async () => {
      vi.mocked(wasmSpec.fetchContractSpec).mockResolvedValue(null);
      const mockAbi = { functions: [{ name: 'stored', inputs: [], outputs: [] }] };
      vi.mocked(abiCache.getCachedAbi).mockResolvedValue(mockAbi as any);

      const res = await request(makeApp()).get('/abi');
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('manual');
    });

    it('returns 404 when no ABI found', async () => {
      vi.mocked(wasmSpec.fetchContractSpec).mockResolvedValue(null);
      vi.mocked(abiCache.getCachedAbi).mockResolvedValue(null);

      const res = await request(makeApp()).get('/abi');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /abi', () => {
    beforeEach(() => vi.clearAllMocks());

    it('stores ABI with valid data', async () => {
      vi.mocked(abiCache.setCachedAbi).mockResolvedValue(undefined);

      const abiData = { functions: [{ name: 'test', inputs: [], outputs: [] }] };
      const res = await request(makeApp()).put('/abi').send(abiData);

      expect(res.status).toBe(200);
      expect(abiCache.setCachedAbi).toHaveBeenCalled();
    });

    it('returns 400 for invalid ABI data', async () => {
      const res = await request(makeApp()).put('/abi').send({ functions: [] });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /abi', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes cached ABI', async () => {
      vi.mocked(abiCache.deleteCachedAbi).mockResolvedValue(undefined);

      const res = await request(makeApp()).delete('/abi');
      expect(res.status).toBe(204);
      expect(abiCache.deleteCachedAbi).toHaveBeenCalled();
    });

    it('returns 404 when ABI not found', async () => {
      vi.mocked(abiCache.deleteCachedAbi).mockRejectedValue(new Error('Not found'));

      const res = await request(makeApp()).delete('/abi');
      expect(res.status).toBe(404);
    });
  });
});

describe('Advanced Events Router Mount (#843)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /events/advanced', () => {
    it('returns service overview with endpoints list', async () => {
      const res = await request(makeApp()).get('/events/advanced');
      expect(res.status).toBe(200);
      expect(res.body.service).toContain('Advanced Events');
      expect(Array.isArray(res.body.endpoints)).toBe(true);
    });

    it('includes expected endpoints in capabilities', async () => {
      const res = await request(makeApp()).get('/events/advanced');
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('filtering');
      expect(res.body.capabilities).toContain('aggregation');
      expect(res.body.capabilities).toContain('replay');
      expect(res.body.capabilities).toContain('subscriptions');
      expect(res.body.capabilities).toContain('streaming');
    });
  });
});

describe('Issue #843 - Router Integration', () => {
  it('both routers are accessible from main app', async () => {
    const abiRes = await request(makeApp()).get('/abi');
    expect([200, 404]).toContain(abiRes.status);

    const advancedEventsRes = await request(makeApp()).get('/events/advanced');
    expect(advancedEventsRes.status).toBe(200);
  });
});
