/**
 * DX04 — try-it console load test.
 *
 * Serves the real try-it router (real OpenAPI spec) over HTTP and replays
 * console sessions: each session loads the page, the script (conditional on
 * ETag after the first load) and the catalog (conditional on ETag after the
 * first load), exactly as a browser does. Budgets:
 *
 *   - zero non-2xx/304 responses;
 *   - p99 latency ≤ TRYIT_P99_BUDGET_MS;
 *   - sustained ≥ 90 % of the target request rate;
 *   - heap growth ≤ TRYIT_HEAP_BUDGET_MB.
 *
 * Defaults are 10× projected peak (docs/try-it/design.md §Capacity):
 * 50 sessions/s ⇒ 150 req/s for 30 minutes.
 *
 * Run: npx ts-node --transpile-only tests/load/tryit-load.ts
 */
import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DURATION_SEC = intEnv('TRYIT_DURATION_SEC', 1800);
const SESSIONS_PER_SEC = intEnv('TRYIT_SESSIONS_PER_SEC', 50);
const P99_BUDGET_MS = intEnv('TRYIT_P99_BUDGET_MS', 200);
const HEAP_BUDGET_MB = intEnv('TRYIT_HEAP_BUDGET_MB', 128);

async function main(): Promise<void> {
  const { createTryItRouter } = await import('../../src/api/tryit/router');
  const { swaggerSpec } = await import('../../src/indexer/swaggerSpec');
  const app = express();
  app.use('/api/try', createTryItRouter({ getSpec: () => swaggerSpec, isEnabled: () => true }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/try`;

  const latencies: number[] = [];
  let failures = 0;
  let requests = 0;
  const etags: Record<string, string> = {};

  async function hit(path: string, conditional: boolean): Promise<void> {
    const started = performance.now();
    const headers: Record<string, string> = {};
    if (conditional && etags[path]) headers['if-none-match'] = etags[path];
    try {
      const res = await fetch(base + path, { headers });
      await res.arrayBuffer();
      if (res.status !== 200 && res.status !== 304) failures += 1;
      const etag = res.headers.get('etag');
      if (etag) etags[path] = etag;
    } catch {
      failures += 1;
    }
    requests += 1;
    latencies.push(performance.now() - started);
  }

  async function session(first: boolean): Promise<void> {
    await hit('', false);
    await Promise.all([hit('/app.js', !first), hit('/catalog.json', !first)]);
  }

  await session(true);
  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;
  const started = Date.now();
  const inflight = new Set<Promise<void>>();
  let sessions = 0;
  while (Date.now() - started < DURATION_SEC * 1000) {
    const tick = Date.now();
    const perTick = Math.max(1, Math.round(SESSIONS_PER_SEC / 10));
    for (let i = 0; i < perTick; i++) {
      const p = session(sessions % 20 === 0).finally(() => inflight.delete(p));
      inflight.add(p);
      sessions += 1;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 100 - (Date.now() - tick))));
  }
  await Promise.all(inflight);
  if (global.gc) global.gc();
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapStart) / 1024 / 1024;
  server.close();

  latencies.sort((a, b) => a - b);
  const p = (q: number) => Math.round(latencies[Math.floor((q / 100) * (latencies.length - 1))]);
  const achievedRate = requests / DURATION_SEC;
  const report = {
    durationSec: DURATION_SEC,
    targetSessionsPerSec: SESSIONS_PER_SEC,
    requests,
    achievedRequestsPerSec: Math.round(achievedRate),
    failures,
    latencyMs: { p50: p(50), p95: p(95), p99: p(99) },
    heapGrowthMb: Math.round(heapGrowthMb * 10) / 10,
  };
  const problems: string[] = [];
  if (failures > 0) problems.push(`${failures} failed request(s)`);
  if (report.latencyMs.p99 > P99_BUDGET_MS) problems.push('p99 over budget');
  if (achievedRate < SESSIONS_PER_SEC * 3 * 0.9) problems.push('could not sustain target rate');
  if (heapGrowthMb > HEAP_BUDGET_MB) problems.push('heap growth over budget');
  process.stdout.write(
    JSON.stringify({ ...report, pass: problems.length === 0, violations: problems }, null, 2) +
      '\n',
  );
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`try-it load failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
