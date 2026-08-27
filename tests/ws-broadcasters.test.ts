import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachArbitrageWebSocket,
  broadcastArbitrageOpportunity,
  getArbitrageWsClientCount,
} from '../src/ws/arbitrageBroadcaster';
import {
  attachComposabilityWebSocket,
  broadcastExploitAlert,
  broadcastCompositionAnalyzed,
} from '../src/ws/composabilityBroadcaster';

const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    server?.close();
  }
});

describe('arbitrageBroadcaster', () => {
  it('filters opportunities by minProfit', async () => {
    const server = createServer();
    servers.push(server);
    attachArbitrageWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/arbitrage/opportunities?minProfit=5`);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastArbitrageOpportunity({
      id: 'opp-1',
      pair: 'USDC/EUR',
      profitPercentage: 3,
      mevScore: 50,
      type: 'triangle',
      route: ['DEX1', 'DEX2', 'DEX3'],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-2',
      pair: 'USDC/EUR',
      profitPercentage: 6,
      mevScore: 50,
      type: 'triangle',
      route: ['DEX1', 'DEX2', 'DEX3'],
      detectedAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages.length).toBeGreaterThanOrEqual(2);
    const connectedMsg = messages[0];
    expect(connectedMsg).toContain('"event":"connected"');

    const opportunityMsgs = messages.filter((m) => m.includes('"event":"new_opportunity"'));
    expect(opportunityMsgs).toHaveLength(1);
    expect(opportunityMsgs[0]).toContain('"id":"opp-2"');

    client.close();
  });

  it('filters opportunities by minMevScore', async () => {
    const server = createServer();
    servers.push(server);
    attachArbitrageWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/ws/arbitrage/opportunities?minMevScore=60`,
    );

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastArbitrageOpportunity({
      id: 'opp-1',
      pair: 'BTC/USD',
      profitPercentage: 10,
      mevScore: 50,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-2',
      pair: 'BTC/USD',
      profitPercentage: 10,
      mevScore: 70,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const opportunityMsgs = messages.filter((m) => m.includes('"event":"new_opportunity"'));
    expect(opportunityMsgs).toHaveLength(1);
    expect(opportunityMsgs[0]).toContain('"id":"opp-2"');

    client.close();
  });

  it('filters opportunities by pair list', async () => {
    const server = createServer();
    servers.push(server);
    attachArbitrageWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/ws/arbitrage/opportunities?pairs=USDC/EUR,BTC/USD`,
    );

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastArbitrageOpportunity({
      id: 'opp-1',
      pair: 'XLM/USD',
      profitPercentage: 8,
      mevScore: 50,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-2',
      pair: 'USDC/EUR',
      profitPercentage: 8,
      mevScore: 50,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const opportunityMsgs = messages.filter((m) => m.includes('"event":"new_opportunity"'));
    expect(opportunityMsgs).toHaveLength(1);
    expect(opportunityMsgs[0]).toContain('"id":"opp-2"');

    client.close();
  });

  it('tracks client count correctly', async () => {
    const server = createServer();
    servers.push(server);
    attachArbitrageWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    expect(getArbitrageWsClientCount()).toBe(0);

    const client1 = new WebSocket(`ws://127.0.0.1:${port}/ws/arbitrage/opportunities`);
    await new Promise<void>((resolve, reject) => {
      client1.once('open', () => resolve());
      client1.once('error', reject);
    });

    expect(getArbitrageWsClientCount()).toBe(1);

    const client2 = new WebSocket(`ws://127.0.0.1:${port}/ws/arbitrage/opportunities`);
    await new Promise<void>((resolve, reject) => {
      client2.once('open', () => resolve());
      client2.once('error', reject);
    });

    expect(getArbitrageWsClientCount()).toBe(2);

    client1.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getArbitrageWsClientCount()).toBe(1);

    client2.close();
  });

  it('combines multiple filters correctly', async () => {
    const server = createServer();
    servers.push(server);
    attachArbitrageWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/ws/arbitrage/opportunities?minProfit=5&minMevScore=50&pairs=USDC/EUR`,
    );

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastArbitrageOpportunity({
      id: 'opp-1',
      pair: 'BTC/USD',
      profitPercentage: 10,
      mevScore: 60,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-2',
      pair: 'USDC/EUR',
      profitPercentage: 3,
      mevScore: 60,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-3',
      pair: 'USDC/EUR',
      profitPercentage: 8,
      mevScore: 30,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    broadcastArbitrageOpportunity({
      id: 'opp-4',
      pair: 'USDC/EUR',
      profitPercentage: 8,
      mevScore: 60,
      type: 'triangle',
      route: [],
      detectedAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const opportunityMsgs = messages.filter((m) => m.includes('"event":"new_opportunity"'));
    expect(opportunityMsgs).toHaveLength(1);
    expect(opportunityMsgs[0]).toContain('"id":"opp-4"');

    client.close();
  });
});

describe('composabilityBroadcaster', () => {
  it('filters exploit alerts by contract address', async () => {
    const server = createServer();
    servers.push(server);
    attachComposabilityWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/composability/exploits?contract=C123`);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastExploitAlert({
      txHash: 'tx-1',
      contractAddress: 'C123',
      exploitType: 'reentrancy',
      severity: 'high',
      confidence: 0.95,
      description: 'Potential reentrancy detected',
      patterns: ['call_before_transfer'],
      timestamp: new Date(),
    });

    broadcastExploitAlert({
      txHash: 'tx-2',
      contractAddress: 'C456',
      exploitType: 'overflow',
      severity: 'high',
      confidence: 0.85,
      description: 'Integer overflow detected',
      patterns: ['unchecked_arithmetic'],
      timestamp: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const alertMsgs = messages.filter((m) => m.includes('"type":"exploit_alert"'));
    expect(alertMsgs).toHaveLength(1);
    expect(alertMsgs[0]).toContain('"contractAddress":"C123"');

    client.close();
  });

  it('filters exploit alerts by severity', async () => {
    const server = createServer();
    servers.push(server);
    attachComposabilityWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/ws/composability/exploits?minSeverity=critical`,
    );

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastExploitAlert({
      exploitType: 'test1',
      severity: 'low',
      confidence: 0.9,
      description: 'Low severity',
      patterns: [],
      timestamp: new Date(),
    });

    broadcastExploitAlert({
      exploitType: 'test2',
      severity: 'high',
      confidence: 0.9,
      description: 'High severity',
      patterns: [],
      timestamp: new Date(),
    });

    broadcastExploitAlert({
      exploitType: 'test3',
      severity: 'critical',
      confidence: 0.9,
      description: 'Critical severity',
      patterns: [],
      timestamp: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const alertMsgs = messages.filter((m) => m.includes('"type":"exploit_alert"'));
    expect(alertMsgs).toHaveLength(1);
    expect(alertMsgs[0]).toContain('"severity":"critical"');

    client.close();
  });

  it('broadcasts composition analyzed events to all clients', async () => {
    const server = createServer();
    servers.push(server);
    attachComposabilityWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages1: string[] = [];
    const messages2: string[] = [];

    const client1 = new WebSocket(`ws://127.0.0.1:${port}/ws/composability/exploits?contract=C123`);
    const client2 = new WebSocket(`ws://127.0.0.1:${port}/ws/composability/exploits?contract=C456`);

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        client1.once('open', () => resolve());
        client1.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        client2.once('open', () => resolve());
        client2.once('error', reject);
      }),
    ]);

    client1.on('message', (data) => messages1.push(String(data)));
    client2.on('message', (data) => messages2.push(String(data)));

    broadcastCompositionAnalyzed({
      txHash: 'tx-analyzed-1',
      safetyScore: 0.95,
      riskLevel: 'low',
      patternCount: 2,
      timestamp: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const analysisMsg1 = messages1.find((m) => m.includes('"type":"composition_analyzed"'));
    const analysisMsg2 = messages2.find((m) => m.includes('"type":"composition_analyzed"'));

    expect(analysisMsg1).toBeDefined();
    expect(analysisMsg2).toBeDefined();
    expect(analysisMsg1).toContain('"txHash":"tx-analyzed-1"');
    expect(analysisMsg2).toContain('"txHash":"tx-analyzed-1"');

    client1.close();
    client2.close();
  });

  it('sends connected message on connection', async () => {
    const server = createServer();
    servers.push(server);
    attachComposabilityWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/composability/exploits`);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    await new Promise((resolve) => setTimeout(resolve, 50));

    const connectedMsg = messages.find((m) => m.includes('"type":"connected"'));
    expect(connectedMsg).toBeDefined();
    expect(connectedMsg).toContain('"path":"/ws/composability/exploits"');

    client.close();
  });

  it('handles default severity filter as low', async () => {
    const server = createServer();
    servers.push(server);
    attachComposabilityWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/composability/exploits`);

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastExploitAlert({
      exploitType: 'test',
      severity: 'low',
      confidence: 0.9,
      description: 'Low severity alert',
      patterns: [],
      timestamp: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const alertMsgs = messages.filter((m) => m.includes('"type":"exploit_alert"'));
    expect(alertMsgs.length).toBeGreaterThan(0);

    client.close();
  });
});
