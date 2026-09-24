import { describe, expect, it, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  attachWebSocketServer,
  broadcastEvent,
  shutdownWebSocketServer,
} from '../src/ws/websocketServer';

vi.mock('../src/db', () => ({
  prismaWrite: {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({ active: true }),
    },
  },
}));

// Pre-populate the ChannelManager in-memory map so isValidChannel returns true
// for channels used in tests without touching the database.
vi.mock('../src/feed/channelManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/feed/channelManager')>();
  for (const name of ['transactions', 'events', 'trades']) {
    (original.ChannelManager as any)['channels'].set(name, {
      name,
      category: 'transaction',
      schema: {},
    });
  }
  return original;
});

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
      `ws://127.0.0.1:${port}/ws/events?apiKey=test-key&contract=C123&eventType=token_transfer`,
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

  it('serves the channel-based feed protocol on the feed path', async () => {
    const server = createServer();
    servers.push(server);
    attachWebSocketServer(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const messages: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/feed/ws?channels=transactions`);
    client.on('message', (data) => messages.push(String(data)));

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    const waitFor = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!messages.some((m) => m.includes(marker))) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${marker}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await waitFor('"type":"welcome"');
    const welcome = JSON.parse(messages.find((m) => m.includes('"type":"welcome"'))!);
    expect(welcome.channels).toEqual(['transactions']);
    expect(typeof welcome.connectionId).toBe('string');

    client.send(JSON.stringify({ type: 'subscribe', channels: ['events'] }));
    await waitFor('"type":"subscribed"');
    const subscribed = JSON.parse(messages.find((m) => m.includes('"type":"subscribed"'))!);
    expect(subscribed.channels).toEqual(['transactions', 'events']);

    client.send(JSON.stringify({ type: 'ping' }));
    await waitFor('"type":"pong"');

    client.close();
  });

  it('rejects feed connections with an invalid channel', async () => {
    const server = createServer();
    servers.push(server);
    attachWebSocketServer(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/feed/ws?channels=nonexistent`);

    const closeCode = await new Promise<number | undefined>((resolve) => {
      client.on('close', (code) => resolve(code));
      client.once('error', () => resolve(undefined));
    });

    expect(closeCode).toBe(1003);
  });
});
