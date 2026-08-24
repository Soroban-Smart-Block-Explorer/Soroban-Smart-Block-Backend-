/**
 * Unified WebSocket server — simple event streaming + channel-based feed
 *
 * A single WebSocketServer (noServer mode) attached to the HTTP server that
 * serves both protocols:
 *
 *   1. Simple event streaming at `/ws/events`
 *      - API-key auth (`?apiKey=`), optional `?contract=` and `?eventType=` filters
 *      - Receives `WsEvent` / `WsEmergency` messages from the event bus and
 *        broadcasts them to matching clients as `{ type: 'event' | 'emergency' }`
 *
 *   2. Channel-based feed at `/api/v1/feed/ws`
 *      - Subscribes to channels (`?channels=transactions,events,...`) with
 *        optional `?filters=` JSON
 *      - Client protocol: `subscribe`, `unsubscribe`, `replay`, `ping`
 *      - Integrated with the feed `streamingServer` for broadcast + replay
 *
 * Merged from `src/ws/eventBroadcaster.ts` (event streaming) and
 * `src/feed/websocketServer.ts` (feed). Connection limits, IP tracking, and
 * the ping/pong heartbeat are shared across both modes. Paths not owned by
 * this server are left for the sibling WebSocket servers (privacy, audit,
 * etc.), mirroring the `noServer` + upgrade-routing pattern already used by
 * `src/ws/privacyBroadcaster.ts`.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { prismaWrite as prisma } from '../db';
import { eventBus, EventNames } from '../events/eventBus';
import { ChannelManager } from '../feed/channelManager';
import { streamingServer, WebSocketStreamConnection } from '../feed/streamingServer';
import { logger } from '../logger';

const WS_API_KEY = process.env.WS_API_KEY ?? '';
// Shared connection budget across both modes. FEED_WS_* env vars take
// precedence (legacy feed config), falling back to WS_* and then defaults.
const MAX_CONNECTIONS_PER_IP = parseInt(
  process.env.FEED_WS_MAX_CONNECTIONS_PER_IP ?? process.env.WS_MAX_CONNECTIONS_PER_IP ?? '5',
  10,
);
const MAX_TOTAL_CONNECTIONS = parseInt(
  process.env.FEED_WS_MAX_TOTAL_CONNECTIONS ?? process.env.WS_MAX_TOTAL_CONNECTIONS ?? '100',
  10,
);

const EVENT_PATH = '/ws/events';
const FEED_PATH = '/api/v1/feed/ws';

type ConnectionMode = 'events' | 'feed';

interface Client {
  ws: WebSocket;
  ip: string;
  isAlive: boolean;
  mode: ConnectionMode;
  // Event mode
  contractFilter: string | null;
  eventTypeFilter: string | null;
  // Feed mode
  feedConnection: WebSocketStreamConnection | null;
}

const clients = new Set<Client>();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  const socket = req.socket;
  return socket.remoteAddress ?? 'unknown';
}

function getConnectionCountForIp(ip: string): number {
  let count = 0;
  for (const client of clients) {
    if (client.ip === ip) count++;
  }
  return count;
}

async function validateApiKey(key: string): Promise<boolean> {
  if (WS_API_KEY && key === WS_API_KEY) return true;

  try {
    const record = await prisma.apiKey.findUnique({ where: { key } });
    return !!record?.active;
  } catch {
    return false;
  }
}

let pingInterval: NodeJS.Timeout | null = null;

function ensureHeartbeat(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 30000);
}

// ── Event mode ────────────────────────────────────────────────────────────────

export interface EventPayload {
  id: string;
  contractAddress: string;
  eventType: string;
  decoded: unknown;
  ledger: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}

async function handleEventConnection(
  ws: WebSocket,
  req: IncomingMessage,
  url: URL,
  ip: string,
): Promise<void> {
  const apiKey = url.searchParams.get('apiKey');
  const contractFilter = url.searchParams.get('contract');
  const eventTypeFilter = url.searchParams.get('eventType');

  if (!apiKey) {
    ws.close(4001, 'Authentication required: provide apiKey query parameter');
    return;
  }

  const valid = await validateApiKey(apiKey);
  if (!valid) {
    ws.close(4002, 'Authentication failed: invalid apiKey');
    return;
  }

  if (clients.size >= MAX_TOTAL_CONNECTIONS) {
    ws.close(4003, 'Server at capacity: too many connections');
    return;
  }

  if (getConnectionCountForIp(ip) >= MAX_CONNECTIONS_PER_IP) {
    ws.close(4004, `Rate limit exceeded: max ${MAX_CONNECTIONS_PER_IP} connections per IP`);
    return;
  }

  const client: Client = {
    ws,
    ip,
    isAlive: true,
    mode: 'events',
    contractFilter: contractFilter ?? null,
    eventTypeFilter: eventTypeFilter ?? null,
    feedConnection: null,
  };
  clients.add(client);

  // Track responses to keep-alive pings
  ws.on('pong', () => {
    client.isAlive = true;
  });

  ws.on('close', () => clients.delete(client));
  ws.on('error', () => clients.delete(client));
}

function sendEventToClients(event: EventPayload): void {
  const payload = JSON.stringify({ type: 'event', data: event });

  for (const client of clients) {
    if (client.mode !== 'events') continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.contractFilter && client.contractFilter !== event.contractAddress) continue;
    if (client.eventTypeFilter && client.eventTypeFilter !== event.eventType) continue;
    client.ws.send(payload);
  }
}

function sendEmergencyToClients(payload: { event: string; data: Record<string, unknown> }): void {
  const msg = JSON.stringify({ type: 'emergency', ...payload });
  for (const client of clients) {
    if (client.mode !== 'events') continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    client.ws.send(msg);
  }
}

let busSubscriptionsReady = false;

function ensureBusSubscriptions(): void {
  if (busSubscriptionsReady) return;
  busSubscriptionsReady = true;

  eventBus.subscribe<EventPayload>(EventNames.WsEvent, (message) =>
    sendEventToClients(message.payload),
  );
  eventBus.subscribe<{ event: string; data: Record<string, unknown> }>(
    EventNames.WsEmergency,
    (message) => sendEmergencyToClients(message.payload),
  );
}

// ── Feed mode ─────────────────────────────────────────────────────────────────

function generateConnectionId(): string {
  return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function handleFeedConnection(ws: WebSocket, req: IncomingMessage, url: URL, ip: string): void {
  if (clients.size >= MAX_TOTAL_CONNECTIONS) {
    ws.close(4003, 'Server at capacity: too many connections');
    return;
  }

  if (getConnectionCountForIp(ip) >= MAX_CONNECTIONS_PER_IP) {
    ws.close(4004, `Rate limit exceeded: max ${MAX_CONNECTIONS_PER_IP} connections per IP`);
    return;
  }

  const channels = url.searchParams.get('channels')?.split(',') || [];
  const filtersParam = url.searchParams.get('filters');
  let filters: Record<string, unknown> = {};

  if (filtersParam) {
    try {
      filters = JSON.parse(filtersParam);
    } catch {
      ws.close(1003, 'Invalid filters JSON');
      return;
    }
  }

  for (const channel of channels) {
    if (!ChannelManager.isValidChannel(channel)) {
      ws.close(1003, `Invalid channel: ${channel}`);
      return;
    }
  }

  const connectionId = generateConnectionId();
  const connection = new WebSocketStreamConnection(connectionId, ws, channels, filters);
  streamingServer.addConnection(connection);

  const client: Client = {
    ws,
    ip,
    isAlive: true,
    mode: 'feed',
    contractFilter: null,
    eventTypeFilter: null,
    feedConnection: connection,
  };
  clients.add(client);

  logger.info(`WebSocket connected: ${connectionId}, channels: ${channels.join(', ')}`);

  ws.send(
    JSON.stringify({
      type: 'welcome',
      connectionId,
      channels,
      timestamp: new Date().toISOString(),
    }),
  );

  ws.on('message', (data: WebSocket.RawData) => {
    handleFeedMessage(connection, data);
  });

  ws.on('close', () => {
    streamingServer.removeConnection(connectionId);
    clients.delete(client);
    logger.info(`WebSocket disconnected: ${connectionId}`);
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error for ${connectionId}:`, { error: String(error) });
    streamingServer.removeConnection(connectionId);
    clients.delete(client);
  });

  ws.on('pong', () => {
    client.isAlive = true;
  });
}

function handleFeedMessage(connection: WebSocketStreamConnection, data: WebSocket.RawData): void {
  try {
    const message = JSON.parse(data.toString());
    switch (message.type) {
      case 'subscribe':
        handleFeedSubscribe(connection, message);
        break;
      case 'unsubscribe':
        handleFeedUnsubscribe(connection, message);
        break;
      case 'replay':
        void handleFeedReplay(connection, message);
        break;
      case 'ping':
        connection.send('pong', { timestamp: new Date().toISOString() });
        break;
    }
  } catch (error) {
    logger.error(`Failed to handle WebSocket message from ${connection.id}:`, error);
  }
}

function handleFeedSubscribe(connection: WebSocketStreamConnection, message: any): void {
  const { channels, filters } = message;

  if (channels) {
    for (const channel of channels) {
      if (ChannelManager.isValidChannel(channel) && !connection.channels.includes(channel)) {
        connection.channels.push(channel);
      }
    }
  }

  if (filters) {
    connection.filters = { ...connection.filters, ...filters };
  }

  connection.send('subscribed', {
    channels: connection.channels,
    filters: connection.filters,
    timestamp: new Date().toISOString(),
  });
}

function handleFeedUnsubscribe(connection: WebSocketStreamConnection, message: any): void {
  const { channels } = message;

  if (channels) {
    connection.channels = connection.channels.filter((ch) => !channels.includes(ch));
  }

  connection.send('unsubscribed', {
    channels: connection.channels,
    timestamp: new Date().toISOString(),
  });
}

async function handleFeedReplay(
  connection: WebSocketStreamConnection,
  message: any,
): Promise<void> {
  const { lastSequence } = message;

  if (lastSequence === undefined) return;

  try {
    const count = await streamingServer.replay(connection, lastSequence);
    connection.send('replay_complete', {
      replayedCount: count,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(`Failed to replay messages for ${connection.id}:`, error);
    connection.send('error', {
      message: 'Failed to replay messages',
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Server attachment ─────────────────────────────────────────────────────────

/**
 * Attach the unified WebSocket server to an HTTP server.
 *
 * Handles upgrades for `/ws/events` (event mode) and `/api/v1/feed/ws` (feed
 * mode) on a single WebSocketServer. Upgrades for any other path are left to
 * the sibling WebSocket servers attached to the same HTTP server.
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  ensureHeartbeat();
  ensureBusSubscriptions();

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === EVENT_PATH || pathname === FEED_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
    // Non-matching paths are intentionally left alone so sibling servers
    // (privacy, composability, arbitrage, audit) can handle their own upgrades.
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const mode: ConnectionMode = url.pathname === FEED_PATH ? 'feed' : 'events';
    const ip = getClientIp(req);

    if (mode === 'events') {
      await handleEventConnection(ws, req, url, ip);
    } else {
      handleFeedConnection(ws, req, url, ip);
    }
  });

  return wss;
}

// ── Broadcast + lifecycle exports (kept for existing importers) ───────────────

export function broadcastEvent(event: EventPayload): void {
  void eventBus.publish(EventNames.WsEvent, event);
}

export function broadcastEmergencyEvent(payload: {
  event: string;
  data: Record<string, unknown>;
}): void {
  void eventBus.publish(EventNames.WsEmergency, payload);
}

export function shutdownWebSocketServer(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(1001, 'Server shutting down');
    }
  }
  clients.clear();
}
