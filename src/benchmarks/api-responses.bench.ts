import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import axios from 'axios';
import { BenchmarkRunner } from './runner';
import { BenchmarkStore } from './comparison';
import type { BenchmarkSuite, BenchmarkResult } from './types';

/**
 * Simplified mock API endpoints for benchmarking
 */
let app: any;
let server: any;

beforeAll(() => {
  app = express();
  app.use(express.json());

  // Mock /api/v1/transactions endpoint
  app.get('/api/v1/transactions', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const transactions = Array.from({ length: limit }, (_, i) => ({
      hash: `tx${i}`.padEnd(64, '0'),
      contract: `CXXX${i}`,
      status: 'success',
      timestamp: new Date().toISOString(),
      humanReadable: `Transaction ${i}`,
    }));
    res.json({
      data: transactions,
      pagination: { limit, offset: 0, total: 1000 },
    });
  });

  // Mock /api/v1/events endpoint
  app.get('/api/v1/events', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
    const events = Array.from({ length: limit }, (_, i) => ({
      id: `evt${i}`,
      contract: `CXXX${i % 10}`,
      type: 'transfer',
      data: { from: 'GXXX', to: 'GYYY', amount: 1000 + i },
      timestamp: new Date().toISOString(),
    }));
    res.json({ data: events, pagination: { limit, offset: 0, total: 5000 } });
  });

  // Mock /api/v1/contracts/:address endpoint
  app.get('/api/v1/contracts/:address', (req, res) => {
    res.json({
      address: req.params.address,
      name: 'StellarSwap DEX',
      recentTransactions: Array.from({ length: 5 }, (_, i) => ({
        hash: `tx${i}`,
        humanReadable: `Swap ${i}`,
      })),
      recentEvents: Array.from({ length: 10 }, (_, i) => ({
        id: `evt${i}`,
        type: 'swap',
      })),
    });
  });

  server = app.listen(13337, () => {
    console.log('Mock API server started on :13337');
  });
});

afterAll(() => {
  return new Promise((resolve) => {
    server.close(() => {
      console.log('Mock API server closed');
      resolve(undefined);
    });
  });
});

describe('API Response Benchmarks', () => {
  const store = new BenchmarkStore();
  const results: BenchmarkResult[] = [];
  const baseUrl = 'http://localhost:13337';

  it('should benchmark transactions list endpoint', async () => {
    const runner = new BenchmarkRunner({
      name: 'transactions-list-response',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runAsync(async () => {
      await axios.get(`${baseUrl}/api/v1/transactions?limit=50`);
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'transactions-list-response',
      path: 'src/api/transactions.ts:GET /api/v1/transactions',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 15,
    });

    expect(metrics.mean).toBeLessThan(100); // API response should be < 100ms
  });

  it('should benchmark events list endpoint', async () => {
    const runner = new BenchmarkRunner({
      name: 'events-list-response',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runAsync(async () => {
      await axios.get(`${baseUrl}/api/v1/events?limit=50`);
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'events-list-response',
      path: 'src/api/events.ts:GET /api/v1/events',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 15,
    });

    expect(metrics.mean).toBeLessThan(100);
  });

  it('should benchmark contract detail endpoint', async () => {
    const runner = new BenchmarkRunner({
      name: 'contract-detail-response',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runAsync(async () => {
      await axios.get(
        `${baseUrl}/api/v1/contracts/CZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ`,
      );
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'contract-detail-response',
      path: 'src/api/contracts.ts:GET /api/v1/contracts/:address',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 20,
    });

    expect(metrics.mean).toBeLessThan(150);
  });

  it('should benchmark transaction list with pagination', async () => {
    const runner = new BenchmarkRunner({
      name: 'transactions-pagination',
      iterations: 100,
      warmupIterations: 10,
    });

    const measurements = await runner.runAsync(async () => {
      await axios.get(`${baseUrl}/api/v1/transactions?limit=100&offset=0`);
    });

    const metrics = BenchmarkRunner.calculateStats(measurements);
    results.push({
      name: 'transactions-pagination',
      path: 'src/api/transactions.ts:GET /api/v1/transactions (paginated)',
      timestamp: new Date().toISOString(),
      metrics,
      threshold: 20,
    });

    expect(metrics.mean).toBeLessThan(200);
  });

  it.after(() => {
    if (results.length > 0) {
      const suite: BenchmarkSuite = {
        name: 'api-responses',
        description: 'API endpoint response time benchmarks',
        results,
        timestamp: new Date().toISOString(),
        duration: results.reduce((sum, r) => sum + r.metrics.mean, 0),
      };

      store.saveSuite(suite);
      const comparisons = store.compare('api-responses', suite);

      console.log('\n=== API Response Benchmark Report ===');
      console.log(store.generateReport(comparisons));

      if (store.hasRegressions(comparisons)) {
        console.warn('\n⚠️ API performance regressions detected!');
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
