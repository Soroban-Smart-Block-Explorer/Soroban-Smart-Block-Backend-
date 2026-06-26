import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../src/db/replicaGateway', () => ({
  getReadClient: vi.fn(),
  measureReplicaLag: vi.fn(),
  LAG_THRESHOLD_LEDGERS: 2,
}));

import { replicaGuard } from '../src/middleware/replicaGuard';
import { getReadClient, measureReplicaLag } from '../src/db/replicaGateway';

const mockGetReadClient = getReadClient as ReturnType<typeof vi.fn>;
const mockMeasureLag = measureReplicaLag as ReturnType<typeof vi.fn>;

function makeRes(): Response {
  return { locals: {}, setHeader: vi.fn() } as unknown as Response;
}

describe('replicaGuard middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockGetReadClient.mockResolvedValue({ _fakeClient: true });
    mockMeasureLag.mockResolvedValue(0);
  });

  it('attaches read client to res.locals.db', async () => {
    const res = makeRes();
    await replicaGuard({} as Request, res, next);
    expect((res as any).locals.db).toBeDefined();
    expect(next).toHaveBeenCalled();
  });

  it('sets X-Replica-Fallback header when lag exceeds threshold', async () => {
    mockMeasureLag.mockResolvedValue(5);
    const res = makeRes();
    await replicaGuard({} as Request, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Replica-Fallback', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('X-Replica-Lag-Ledgers', '5');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set fallback header when lag is within threshold', async () => {
    mockMeasureLag.mockResolvedValue(1);
    const res = makeRes();
    await replicaGuard({} as Request, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith('X-Replica-Fallback', 'true');
    expect(next).toHaveBeenCalled();
  });

  it('still calls next even when getReadClient throws', async () => {
    mockGetReadClient.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await replicaGuard({} as Request, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('still calls next even when measureReplicaLag throws', async () => {
    mockMeasureLag.mockRejectedValue(new Error('timeout'));
    const res = makeRes();
    await replicaGuard({} as Request, res, next);
    expect(next).toHaveBeenCalled();
  });
});
