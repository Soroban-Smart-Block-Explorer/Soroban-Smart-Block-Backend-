import { describe, it, expect, afterAll } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { BenchmarkRunner } from './runner';
import { BenchmarkStore } from './comparison';
import type { BenchmarkSuite, BenchmarkResult } from './types';
import { decodeEvent } from '../indexer/decoder';

/**
 * Create mock Soroban event data for benchmarking
 */
function createMockSorobanEvent() {
  // SEP-41 transfer event: transfer(from, to, amount)
  const keyEd25519 = xdr.PublicKey.publicKeyTypeEd25519(xdr.Uint256.fromXDR(Buffer.alloc(32, 1)));
  const addr1 = xdr.ScAddress.scAddressTypeAccountId(keyEd25519);
  const fromAccount = xdr.ScVal.scvAddress(addr1);

  const keyEd25519_2 = xdr.PublicKey.publicKeyTypeEd25519(xdr.Uint256.fromXDR(Buffer.alloc(32, 2)));
  const addr2 = xdr.ScAddress.scAddressTypeAccountId(keyEd25519_2);
  const toAccount = xdr.ScVal.scvAddress(addr2);

  const amount = xdr.ScVal.scvI128(xdr.Int128Parts.fromString('1000000'));

  // Event symbol: "transfer"
  const eventSymbol = xdr.ScVal.scvSymbol(Buffer.from('transfer'));

  return {
    topics: [eventSymbol.toXDR('base64'), fromAccount.toXDR('base64'), toAccount.toXDR('base64')],
    data: amount.toXDR('base64'),
  };
}

/**
 * Create complex generic event with nested data
 */
function createComplexEvent() {
  const field1 = xdr.ScVal.scvSymbol(Buffer.from('field1'));
  const field2 = xdr.ScVal.scvI128(xdr.Int128Parts.fromString('12345'));
  const field3 = xdr.ScVal.scvBool(true);

  const map = xdr.ScVal.scvMap([
    { key: xdr.ScVal.scvSymbol(Buffer.from('key1')), val: field1 },
    { key: xdr.ScVal.scvSymbol(Buffer.from('key2')), val: field2 },
    { key: xdr.ScVal.scvSymbol(Buffer.from('key3')), val: field3 },
  ]);

  const eventName = xdr.ScVal.scvSymbol(Buffer.from('complex_event'));

  return {
    topics: [eventName.toXDR('base64')],
    data: map.toXDR('base64'),
  };
}

describe('Event Decoding Benchmarks', () => {
  const store = new BenchmarkStore();
  const results: BenchmarkResult[] = [];

  it('should benchmark SEP-41 transfer event decoding', async () => {
    const runner = new BenchmarkRunner({
      name: 'sep41-transfer-decode',
      iterations: 1000,
      warmupIterations: 50,
    });

    const mockEvent = createMockSorobanEvent();

    const measurements = await runner.runSync(() => {
      decodeEvent(mockEvent.topics, mockEvent.data, 'TestToken');
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'sep41-transfer-decode',
      path: 'src/indexer/decoder.ts:decodeEvent',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 10,
    });

    expect(metrics.mean).toBeLessThan(5); // Should decode in < 5ms on average
  });

  it('should benchmark complex event decoding', async () => {
    const runner = new BenchmarkRunner({
      name: 'complex-event-decode',
      iterations: 500,
      warmupIterations: 25,
    });

    const mockEvent = createComplexEvent();

    const measurements = await runner.runSync(() => {
      decodeEvent(mockEvent.topics, mockEvent.data);
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'complex-event-decode',
      path: 'src/indexer/decoder.ts:decodeEvent',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 15,
    });

    expect(metrics.mean).toBeLessThan(10); // Should decode in < 10ms on average
  });

  it('should benchmark XDR parsing overhead', async () => {
    const runner = new BenchmarkRunner({
      name: 'xdr-parse-overhead',
      iterations: 2000,
      warmupIterations: 100,
    });

    const mockEvent = createMockSorobanEvent();

    const measurements = await runner.runSync(() => {
      xdr.ScVal.fromXDR(mockEvent.topics[0], 'base64');
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'xdr-parse-overhead',
      path: 'src/indexer/decoder.ts',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 8,
    });

    expect(metrics.mean).toBeLessThan(2); // XDR parsing should be fast
  });

  // Run after all tests to generate report
  afterAll(() => {
    if (results.length > 0) {
      const suite: BenchmarkSuite = {
        name: 'event-decoding',
        description: 'Event decoding performance benchmarks',
        results,
        timestamp: new Date().toISOString(),
        duration: results.reduce((sum, r) => sum + r.metrics.mean, 0),
      };

      store.saveSuite(suite);
      const comparisons = store.compare('event-decoding', suite);

      console.log('\n=== Event Decoding Benchmark Report ===');
      console.log(store.generateReport(comparisons));

      if (store.hasRegressions(comparisons)) {
        console.warn('\n⚠️ Performance regressions detected!');
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
