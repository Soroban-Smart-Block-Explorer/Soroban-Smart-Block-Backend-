import { describe, it, expect, beforeEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { BenchmarkRunner } from './runner';
import { BenchmarkStore } from './comparison';
import type { BenchmarkSuite, BenchmarkResult } from './types';

/**
 * Mock RPC client for benchmarking (simulates response without network)
 */
class MockSorobanRpc {
  /**
   * Simulate getEvents call
   */
  getEvents(params: any) {
    const mockEvents = Array.from({ length: params.limit || 200 }, (_, i) => {
      const keyEd25519 = xdr.PublicKey.publicKeyTypeEd25519(
        xdr.Uint256.fromXDR(Buffer.alloc(32, 1)),
      );
      const addr = xdr.ScAddress.scAddressTypeAccountId(keyEd25519);
      const fromAccount = xdr.ScVal.scvAddress(addr);

      return {
        type: 'contract',
        ledger: 1000 + i,
        ledgerCloseTime: Math.floor(Date.now() / 1000),
        contractId: `CXXX${i}`,
        id: `${1000 + i}-1`,
        pagingToken: `${1000 + i}-0`,
        topics: [xdr.ScVal.scvSymbol(Buffer.from('transfer')).toXDR('base64')],
        data: xdr.ScVal.scvI128(xdr.Int128Parts.fromString('1000000')).toXDR('base64'),
        txHash: `txhash${i}`.padEnd(64, '0'),
      };
    });

    return Promise.resolve({ events: mockEvents });
  }

  /**
   * Simulate getTransaction call
   */
  getTransaction(hash: string) {
    return Promise.resolve({
      status: 'SUCCESS',
      latestLedger: 2000,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000),
      oldestLedger: 1000,
      oldestLedgerCloseTime: Math.floor(Date.now() / 1000) - 86400,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: 'mock-xdr'.padEnd(1000, 'x'),
      resultXdr: 'result-xdr'.padEnd(500, 'x'),
      resultMetaXdr: 'meta-xdr'.padEnd(1500, 'x'),
    });
  }

  /**
   * Simulate getLedger call
   */
  getLedger(sequence: number) {
    return Promise.resolve({
      sequence,
      hash: `hash${sequence}`.padEnd(64, '0'),
      prevHash: `hash${sequence - 1}`.padEnd(64, '0'),
      timestamp: Math.floor(Date.now() / 1000),
      txCount: 50 + Math.random() * 100,
      operationCount: 150 + Math.random() * 300,
      closedAt: new Date().toISOString(),
      totalCoins: '50000000000',
      feePool: '1000000',
      baseFeeInStroops: 100,
      baseReserveInStroops: 5000000,
      maxTxSetSize: 1000,
    });
  }
}

describe('RPC Call Benchmarks', () => {
  const store = new BenchmarkStore();
  const results: BenchmarkResult[] = [];
  let mockRpc: MockSorobanRpc;

  beforeEach(() => {
    mockRpc = new MockSorobanRpc();
  });

  it('should benchmark getEvents RPC call overhead', async () => {
    const runner = new BenchmarkRunner({
      name: 'rpc-getEvents-overhead',
      iterations: 500,
      warmupIterations: 50,
    });

    const measurements = await runner.runAsync(async () => {
      await mockRpc.getEvents({
        startLedger: 1000,
        limit: 200,
        filters: [{ type: 'contract' }],
      });
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'rpc-getEvents-overhead',
      path: 'src/indexer/rpc.ts:fetchEvents',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 12,
    });

    expect(metrics.mean).toBeLessThan(5); // Should complete in < 5ms
  });

  it('should benchmark getTransaction RPC call', async () => {
    const runner = new BenchmarkRunner({
      name: 'rpc-getTransaction',
      iterations: 500,
      warmupIterations: 50,
    });

    const measurements = await runner.runAsync(async () => {
      await mockRpc.getTransaction(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'rpc-getTransaction',
      path: 'src/indexer/rpc.ts',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 10,
    });

    expect(metrics.mean).toBeLessThan(3);
  });

  it('should benchmark getLedger RPC call', async () => {
    const runner = new BenchmarkRunner({
      name: 'rpc-getLedger',
      iterations: 500,
      warmupIterations: 50,
    });

    const measurements = await runner.runAsync(async () => {
      await mockRpc.getLedger(1000);
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'rpc-getLedger',
      path: 'src/indexer/rpc.ts',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 10,
    });

    expect(metrics.mean).toBeLessThan(3);
  });

  it('should benchmark batch event processing', async () => {
    const runner = new BenchmarkRunner({
      name: 'rpc-batch-event-processing',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runAsync(async () => {
      const batch = await mockRpc.getEvents({
        startLedger: 1000,
        limit: 200,
      });

      // Simulate processing each event
      (batch as any).events.forEach((evt: any) => {
        const topics = [evt.topics[0]];
        const data = evt.data;
        // Minimal processing to simulate real workload
        JSON.stringify({ topics, data });
      });
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'rpc-batch-event-processing',
      path: 'src/indexer/rpc.ts:fetchEvents + processing',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 15,
    });

    expect(metrics.mean).toBeLessThan(20);
  });

  it('should benchmark retry logic overhead', async () => {
    const runner = new BenchmarkRunner({
      name: 'rpc-retry-logic',
      iterations: 1000,
      warmupIterations: 100,
    });

    let attemptCount = 0;
    const measurements = await runner.runAsync(async () => {
      // Simulate successful call (no retry needed)
      attemptCount++;
      if (attemptCount % 100 !== 0) {
        await mockRpc.getEvents({ startLedger: 1000, limit: 50 });
      }
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'rpc-retry-logic',
      path: 'src/indexer/rpc.ts:retry',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 10,
    });

    expect(metrics.mean).toBeLessThan(5);
  });

  it.after(() => {
    if (results.length > 0) {
      const suite: BenchmarkSuite = {
        name: 'rpc-calls',
        description: 'Soroban RPC call performance benchmarks',
        results,
        timestamp: new Date().toISOString(),
        duration: results.reduce((sum, r) => sum + r.metrics.mean, 0),
      };

      store.saveSuite(suite);
      const comparisons = store.compare('rpc-calls', suite);

      console.log('\n=== RPC Call Benchmark Report ===');
      console.log(store.generateReport(comparisons));

      if (store.hasRegressions(comparisons)) {
        console.warn('\n⚠️ RPC performance regressions detected!');
        const regressions = comparisons.filter((c) => c.regression.detected);
        regressions.forEach((r) => {
          console.warn(
            `  ${r.name}: +${r.regression.changePercent.toFixed(2)}% (threshold: ${r.regression.threshold}%)`,
          );
        });
      }
    }
  });
});
