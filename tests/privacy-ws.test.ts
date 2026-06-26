import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachPrivacyWebSocket,
  broadcastPrivacyTransaction,
  broadcastPrivacyAlert,
} from '../src/ws/privacyBroadcaster';

// ── Test server ───────────────────────────────────────────────────────────────

let httpServer: Server;
let port: number;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      httpServer = createServer();
      attachPrivacyWebSocket(httpServer);
      httpServer.listen(0, '127.0.0.1', () => {
        port = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    ),
);

function wsConnect(path: string, params = ''): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${params}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
}

// ── attachPrivacyWebSocket starts both WS servers ────────────────────────────

describe('attachPrivacyWebSocket', () => {
  it('returns both privacy and alert WebSocketServer instances', () => {
    const result = attachPrivacyWebSocket(createServer());
    expect(result).toHaveProperty('privacyWss');
    expect(result).toHaveProperty('alertWss');
  });
});

// ── /ws/v1/privacy ────────────────────────────────────────────────────────────

describe('broadcastPrivacyTransaction', () => {
  it('delivers a privacy_transaction message to connected clients', async () => {
    const ws = await wsConnect('/ws/v1/privacy');
    const msgPromise = nextMessage(ws);

    broadcastPrivacyTransaction({
      txHash: 'abc123',
      protocols: ['ZK_SNARK'],
      privacyScore: 85,
      riskScore: 10,
      anonymitySetSize: 100,
      totalValue: '5000',
      usdValue: 5000,
      participants: ['GABC'],
      timestamp: new Date(),
    });

    const msg = await msgPromise;
    expect(msg).toMatchObject({ type: 'privacy_transaction', data: { txHash: 'abc123' } });
    ws.close();
  });

  it('filters by minValue — skips low-value transactions', async () => {
    const ws = await wsConnect('/ws/v1/privacy', '?minValue=10000');
    let received = false;
    ws.on('message', () => {
      received = true;
    });

    broadcastPrivacyTransaction({
      txHash: 'low-value',
      protocols: ['MIXER'],
      privacyScore: 50,
      riskScore: 30,
      anonymitySetSize: 50,
      totalValue: '100',
      usdValue: 100,
      participants: ['GABC'],
      timestamp: new Date(),
    });

    // Give a moment for potential delivery
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);
    ws.close();
  });

  it('filters by protocol — skips non-matching protocols', async () => {
    const ws = await wsConnect('/ws/v1/privacy', '?protocols=ZK_SNARK');
    let received = false;
    ws.on('message', () => {
      received = true;
    });

    broadcastPrivacyTransaction({
      txHash: 'mixer-only',
      protocols: ['MIXER'],
      privacyScore: 50,
      riskScore: 30,
      anonymitySetSize: 50,
      totalValue: '100',
      usdValue: 1000,
      participants: ['GABC'],
      timestamp: new Date(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);
    ws.close();
  });
});

// ── /ws/v1/privacy/alerts ─────────────────────────────────────────────────────

describe('broadcastPrivacyAlert', () => {
  it('delivers an alert message to alert clients', async () => {
    const ws = await wsConnect('/ws/v1/privacy/alerts');
    const msgPromise = nextMessage(ws);

    broadcastPrivacyAlert({
      type: 'high_risk_tx',
      severity: 'high',
      title: 'High-risk transaction detected',
      description: 'ZK mixer with >70 risk score',
      txHash: 'abc123',
      address: 'GABC',
      confidence: 0.9,
      timestamp: new Date(),
    });

    const msg = await msgPromise;
    expect(msg).toMatchObject({
      type: 'alert',
      data: { type: 'high_risk_tx', severity: 'high' },
    });
    ws.close();
  });
});
