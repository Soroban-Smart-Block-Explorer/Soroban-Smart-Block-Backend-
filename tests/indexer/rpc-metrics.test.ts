/**
 * #910 — Outbound Stellar RPC and Horizon calls must be instrumented:
 * rpc_call_duration_seconds / horizon_call_duration_seconds histograms plus
 * error and retry counters, with operation/status labels. Instrumentation
 * lives inside retry()/horizonCall() so every call site is covered for free.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registry } from '../../src/metrics';

const { sharedMockServer } = vi.hoisted(() => ({
  sharedMockServer: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
    getTransaction: vi.fn(),
    getLedger: vi.fn(),
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  function MockServer() {
    return sharedMockServer;
  }
  return { SorobanRpc: { Server: MockServer } };
});

vi.mock('../../src/cache', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/config', () => ({
  config: {
    profile: { name: 'devnet' },
    stellarRpcUrl: 'http://localhost:8000',
    stellarRpcWsUrl: 'ws://localhost:8000',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
}));

const { axiosGetMock } = vi.hoisted(() => ({ axiosGetMock: vi.fn() }));
vi.mock('axios', () => ({
  __esModule: true,
  default: { get: axiosGetMock },
}));

import { fetchEvents, getLatestLedger, getTransactionFromHorizon } from '../../src/indexer/rpc';

async function metricText(name: string): Promise<string> {
  return registry.getSingleMetricAsString(name);
}

describe('RPC/Horizon outbound metrics (#910)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records rpc_call_duration_seconds with operation and status on success', async () => {
    sharedMockServer.getEvents.mockResolvedValue({ events: [] });
    await fetchEvents(1000, 1010);

    const out = await metricText('rpc_call_duration_seconds');
    expect(out).toContain(
      'rpc_call_duration_seconds_count{operation="getEvents",status="success"}',
    );
  });

  it('records duration and error counter on RPC failure', async () => {
    sharedMockServer.getEvents.mockRejectedValue(new Error('Network error'));
    await expect(fetchEvents(1000, 1010)).rejects.toThrow('Network error');

    const duration = await metricText('rpc_call_duration_seconds');
    expect(duration).toContain(
      'rpc_call_duration_seconds_count{operation="getEvents",status="error"}',
    );

    const errors = await metricText('rpc_call_errors_total');
    expect(errors).toContain('rpc_call_errors_total{operation="getEvents",type="error"} 1');
  });

  it('counts rate-limit retries in rpc_call_retries_total', async () => {
    const rateLimitError = { response: { status: 429 } };
    sharedMockServer.getEvents
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ events: [] });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchPromise = fetchEvents(1000, 1010);
    await vi.runAllTimersAsync();
    await fetchPromise;

    const retries = await metricText('rpc_call_retries_total');
    expect(retries).toContain('rpc_call_retries_total{operation="getEvents"} 1');

    const errors = await metricText('rpc_call_errors_total');
    expect(errors).toContain('rpc_call_errors_total{operation="getEvents",type="rate_limit"} 1');
  });

  it('records horizon_call_duration_seconds for Horizon transaction lookups', async () => {
    axiosGetMock.mockResolvedValue({
      data: {
        successful: true,
        source_account: 'GABC',
        fee_charged: '100',
        envelope_xdr: 'AAAA',
      },
    });

    const result = await getTransactionFromHorizon('tx-hash-1');
    expect(result.status).toBe('SUCCESS');

    const out = await metricText('horizon_call_duration_seconds');
    expect(out).toContain(
      'horizon_call_duration_seconds_count{operation="transactions",status="success"}',
    );
  });

  it('records horizon errors in horizon_call_errors_total', async () => {
    axiosGetMock.mockRejectedValue(new Error('Horizon 500'));

    await expect(getTransactionFromHorizon('tx-hash-2')).rejects.toThrow('Horizon 500');

    const out = await metricText('horizon_call_errors_total');
    expect(out).toContain('horizon_call_errors_total{operation="transactions",type="error"} 1');
  });

  it('labels getLatestLedger operations', async () => {
    sharedMockServer.getLatestLedger.mockResolvedValue({ sequence: '12345' });
    await getLatestLedger();

    const out = await metricText('rpc_call_duration_seconds');
    expect(out).toContain(
      'rpc_call_duration_seconds_count{operation="getLatestLedger",status="success"}',
    );
  });
});
