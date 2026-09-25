/**
 * DX03 — GraphQL subscription soak / load test.
 *
 * Boots the real GraphQL server (graphql-yoga, same handler mounted at
 * /api/graphql in production) on an ephemeral port, opens SOAK_SUBSCRIBERS
 * SSE subscription streams over real HTTP, publishes SOAK_RATE messages/s
 * through the production feed bridge for SOAK_DURATION_SEC seconds and then
 * enforces hard budgets:
 *
 *   - zero message loss on every stream (each stream receives exactly the
 *     messages its filter matches);
 *   - end-to-end delivery latency p99 ≤ SOAK_P99_BUDGET_MS;
 *   - heap growth ≤ SOAK_HEAP_BUDGET_MB (leak detection);
 *   - all subscription slots released after clients disconnect.
 *
 * Defaults are 10× the projected peak documented in
 * docs/graphql-subscriptions/design.md (§Capacity): 2000 streams, 400 msg/s,
 * sustained for 30 minutes. CI runs a short smoke on PRs and the full soak
 * nightly (.github/workflows/soak.yml).
 *
 * Run:  npx ts-node --transpile-only tests/load/graphql-subscriptions-soak.ts
 * Exit: 0 when every budget holds, 1 otherwise. Prints a JSON report.
 */
import http from 'http';
import { AddressInfo } from 'net';

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DURATION_SEC = intEnv('SOAK_DURATION_SEC', 1800);
const SUBSCRIBERS = intEnv('SOAK_SUBSCRIBERS', 2000);
const RATE = intEnv('SOAK_RATE', 400);
const CONTRACTS = intEnv('SOAK_CONTRACTS', 100);
const P99_BUDGET_MS = intEnv('SOAK_P99_BUDGET_MS', 250);
const HEAP_BUDGET_MB = intEnv('SOAK_HEAP_BUDGET_MB', 256);

// Slots are keyed per client IP; the soak drives every stream from one host.
process.env.GQL_SUBSCRIPTION_MAX_PER_CLIENT ??= String(SUBSCRIBERS + 10);
process.env.GQL_SUBSCRIPTION_MAX_GLOBAL ??= String(SUBSCRIBERS + 10);

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const contractIds = Array.from(
  { length: CONTRACTS },
  (_, i) => 'C' + ALPHA[Math.floor(i / 26) % 26] + ALPHA[i % 26] + 'A'.repeat(53),
);

interface Stream {
  contract: string;
  received: number;
  abort: AbortController;
  done: Promise<void>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const { default: yoga } = await import('../../src/graphql');
  const { bridgeRealtimeMessage, subscriptionLimiter } =
    await import('../../src/graphql/subscriptions');

  const server = http.createServer(yoga);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/api/graphql`;

  const latencies: number[] = [];
  const query = `subscription($c: String!) { eventEmitted(contract: $c) { id topicSymbol } }`;

  function open(contract: string): Stream {
    const abort = new AbortController();
    const stream: Stream = { contract, received: 0, abort, done: Promise.resolve() };
    stream.done = (async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ query, variables: { c: contract } }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`subscribe failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine || !frame.includes('event: next')) continue;
            const payload = JSON.parse(dataLine.slice(6)) as {
              data?: { eventEmitted?: { topicSymbol?: string } };
            };
            const sentAt = Number(payload.data?.eventEmitted?.topicSymbol?.slice(1));
            if (Number.isFinite(sentAt)) latencies.push(Date.now() - sentAt);
            stream.received += 1;
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') throw err;
      }
    })();
    return stream;
  }

  const streams = Array.from({ length: SUBSCRIBERS }, (_, i) =>
    open(contractIds[i % contractIds.length]),
  );
  const openDeadline = Date.now() + 60_000;
  while (subscriptionLimiter.activeTotal() < SUBSCRIBERS) {
    if (Date.now() > openDeadline) {
      throw new Error(`only ${subscriptionLimiter.activeTotal()}/${SUBSCRIBERS} streams opened`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;
  const sentPerContract = new Map<string, number>();
  let sent = 0;
  const started = Date.now();
  const tickMs = 100;
  const perTick = Math.max(1, Math.round((RATE * tickMs) / 1000));

  while (Date.now() - started < DURATION_SEC * 1000) {
    const tickStart = Date.now();
    for (let i = 0; i < perTick; i++) {
      const contract = contractIds[sent % contractIds.length];
      bridgeRealtimeMessage('events', {
        id: `soak-${sent}`,
        transactionHash: `tx-${sent}`,
        contractAddress: contract,
        eventType: 'contract',
        topicSymbol: `t${Date.now()}`,
        ledgerSequence: Math.floor(sent / 50),
        timestamp: new Date().toISOString(),
      });
      sentPerContract.set(contract, (sentPerContract.get(contract) ?? 0) + 1);
      sent += 1;
    }
    const elapsed = Date.now() - tickStart;
    await new Promise((r) => setTimeout(r, Math.max(0, tickMs - elapsed)));
  }

  // Drain: allow in-flight frames to arrive.
  const drainDeadline = Date.now() + 10_000;
  const expectedFor = (s: Stream) => sentPerContract.get(s.contract) ?? 0;
  while (streams.some((s) => s.received < expectedFor(s)) && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  if (global.gc) global.gc();
  const heapEnd = process.memoryUsage().heapUsed;
  const lossyStreams = streams.filter((s) => s.received !== expectedFor(s)).length;

  for (const s of streams) s.abort.abort();
  await Promise.allSettled(streams.map((s) => s.done));
  const releaseDeadline = Date.now() + 10_000;
  while (subscriptionLimiter.activeTotal() > 0 && Date.now() < releaseDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  server.close();

  latencies.sort((a, b) => a - b);
  const report = {
    durationSec: DURATION_SEC,
    subscribers: SUBSCRIBERS,
    targetRate: RATE,
    achievedRate: Math.round(sent / DURATION_SEC),
    messagesSent: sent,
    deliveries: latencies.length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    lossyStreams,
    heapGrowthMb: Math.round(((heapEnd - heapStart) / 1024 / 1024) * 10) / 10,
    slotsLeakedAfterDisconnect: subscriptionLimiter.activeTotal(),
    budgets: { p99Ms: P99_BUDGET_MS, heapGrowthMb: HEAP_BUDGET_MB },
  };

  const failures: string[] = [];
  if (lossyStreams > 0) failures.push(`${lossyStreams} stream(s) lost messages`);
  if (report.latencyMs.p99 > P99_BUDGET_MS) failures.push('p99 latency over budget');
  if (report.heapGrowthMb > HEAP_BUDGET_MB) failures.push('heap growth over budget');
  if (report.slotsLeakedAfterDisconnect > 0) failures.push('subscription slots leaked');
  if (report.achievedRate < RATE * 0.9) failures.push('publisher could not sustain target rate');

  process.stdout.write(
    JSON.stringify({ ...report, pass: failures.length === 0, failures }, null, 2),
  );
  process.stdout.write('\n');
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`soak failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
