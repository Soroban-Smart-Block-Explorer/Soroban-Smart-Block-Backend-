import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachWebSocketServer,
  broadcastEvent,
  shutdownWebSocketServer,
} from '../src/ws/eventBroadcaster';

const servers: Server[] = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    shutdownWebSocketServer();
    server?.close();
  }
});

describe('event broadcaster', () => {
  it('filters events by contract and event type for matching clients', async () => {
    const server = createServer();
    servers.push(server);
    attachWebSocketServer(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/ws/events?contract=C123&eventType=token_transfer`,
    );

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    client.on('message', (data) => messages.push(String(data)));

    broadcastEvent({
      id: 'evt-1',
      contractAddress: 'C123',
      eventType: 'token_transfer',
      decoded: { amount: 10 },
      ledger: 100,
      ledgerCloseTime: new Date('2024-01-01T00:00:00.000Z'),
      transactionHash: 'tx-1',
    });

    broadcastEvent({
      id: 'evt-2',
      contractAddress: 'C456',
      eventType: 'token_transfer',
      decoded: { amount: 20 },
      ledger: 101,
      ledgerCloseTime: new Date('2024-01-01T00:00:00.000Z'),
      transactionHash: 'tx-2',
    });

    broadcastEvent({
      id: 'evt-3',
      contractAddress: 'C123',
      eventType: 'swap',
      decoded: { amount: 30 },
      ledger: 102,
      ledgerCloseTime: new Date('2024-01-01T00:00:00.000Z'),
      transactionHash: 'tx-3',
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('"id":"evt-1"');

    client.close();
  });
});
