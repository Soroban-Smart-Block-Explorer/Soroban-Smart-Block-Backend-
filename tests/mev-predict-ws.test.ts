import { describe, expect, it, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

vi.mock('../src/db', () => ({
  prismaRead: {},
  prismaWrite: {},
}));

import {
  attachMevPredictWebSocket,
  broadcastMevPrediction,
  broadcastMevPredictions,
  getMevPredictWsClientCount,
  selectNewPredictions,
  startMevPredictionPublisher,
  stopMevPredictionPublisher,
} from '../src/ws/mevPredictBroadcaster';
import type { MevPrediction } from '../src/indexer/mev-predictor';

const NOW = '2026-06-19T07:24:26.000Z';

function prediction(overrides: Partial<MevPrediction> = {}): MevPrediction {
  return {
    id: 'mevpred_1',
    type: 'sandwich',
    stage: 'pending',
    target: { txHash: 'tx1', contractAddress: 'CCONTRACT1', pair: 'XLM/USDC' },
    score: 80,
    confidence: 0.9,
    sensitivity: 0.5,
    expectedProfitUsd: 120.5,
    leadTimeMs: 2500,
    rationale: ['Pending swap notional ~$50,000'],
    features: { notional: 1 },
    predictedAt: NOW,
    ...overrides,
  };
}

interface WsMessage {
  event: string;
  data: Record<string, unknown>;
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  while (servers.length > 0) servers.pop()?.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

async function connect(path: string): Promise<{ ws: WebSocket; messages: WsMessage[] }> {
  const server = createServer();
  servers.push(server);
  attachMevPredictWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  sockets.push(ws);
  const messages: WsMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsMessage));

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('MEV prediction broadcaster', () => {
  it('delivers only the signal types a client subscribed to', async () => {
    const sandwich = await connect('/ws/mev/predictions?types=sandwich');
    const arbitrage = await connect('/ws/mev/predictions?types=arbitrage');

    broadcastMevPrediction(prediction({ type: 'sandwich' }));
    await settle();

    const sandwichSignals = sandwich.messages.filter((m) => m.event === 'mev_prediction');
    const arbitrageSignals = arbitrage.messages.filter((m) => m.event === 'mev_prediction');
    expect(sandwichSignals).toHaveLength(1);
    expect(sandwichSignals[0].data.type).toBe('sandwich');
    expect(arbitrageSignals).toHaveLength(0);
  });

  it('enforces the minScore filter', async () => {
    const client = await connect('/ws/mev/predictions?minScore=90');

    broadcastMevPrediction(prediction({ score: 80 }));
    broadcastMevPrediction(prediction({ id: 'mevpred_2', score: 95 }));
    await settle();

    const signals = client.messages.filter((m) => m.event === 'mev_prediction');
    expect(signals).toHaveLength(1);
    expect(signals[0].data.score).toBe(95);
  });

  it('filters by pair and contract', async () => {
    const client = await connect('/ws/mev/predictions?pair=XLM/USDC&contract=CCONTRACT1');

    broadcastMevPrediction(prediction());
    broadcastMevPrediction(prediction({ target: { txHash: 'tx2', pair: 'A/B' } }));
    await settle();

    expect(client.messages.filter((m) => m.event === 'mev_prediction')).toHaveLength(1);
  });

  it('updates filters from a runtime config message', async () => {
    const client = await connect('/ws/mev/predictions');
    expect(client.messages[0].event).toBe('connected');

    client.ws.send(JSON.stringify({ type: 'config', types: ['liquidation'], minScore: 70 }));
    await settle();
    expect(client.messages.some((m) => m.event === 'config_updated')).toBe(true);

    broadcastMevPrediction(prediction({ type: 'sandwich', score: 80 }));
    broadcastMevPrediction(prediction({ id: 'mevpred_3', type: 'liquidation', score: 75 }));
    await settle();

    const signals = client.messages.filter((m) => m.event === 'mev_prediction');
    expect(signals).toHaveLength(1);
    expect(signals[0].data.type).toBe('liquidation');
  });

  it('broadcasts a batch and reports client count', async () => {
    const client = await connect('/ws/mev/predictions?types=arbitrage,sandwich');
    expect(getMevPredictWsClientCount()).toBeGreaterThanOrEqual(1);

    const delivered = broadcastMevPredictions([
      prediction({ type: 'arbitrage' }),
      prediction({ id: 'mevpred_4', type: 'sandwich' }),
    ]);
    await settle();

    expect(delivered).toBe(2);
    expect(client.messages.filter((m) => m.event === 'mev_prediction')).toHaveLength(2);
  });
});

describe('MEV prediction publisher', () => {
  it('emits only new or changed-score predictions per tick', () => {
    const seen = new Map<string, number>();

    expect(
      selectNewPredictions(seen, [prediction({ score: 80 }), prediction({ id: 'b', score: 50 })]),
    ).toHaveLength(2);
    expect(
      selectNewPredictions(seen, [prediction({ score: 80 }), prediction({ id: 'b', score: 50 })]),
    ).toHaveLength(0);

    const changed = selectNewPredictions(seen, [
      prediction({ score: 85 }),
      prediction({ id: 'b', score: 50 }),
    ]);
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe('mevpred_1');
  });

  it('starts and stops idempotently', () => {
    expect(() => {
      startMevPredictionPublisher(60_000);
      startMevPredictionPublisher(60_000);
      stopMevPredictionPublisher();
      stopMevPredictionPublisher();
    }).not.toThrow();
  });
});
