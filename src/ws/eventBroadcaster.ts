import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { prismaWrite as prisma } from '../db';

const WS_API_KEY = process.env.WS_API_KEY ?? '';
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP ?? '5', 10);
const MAX_TOTAL_CONNECTIONS = parseInt(process.env.WS_MAX_TOTAL_CONNECTIONS ?? '100', 10);

interface Client {
  ws: WebSocket;
  contractFilter: string | null;
  eventTypeFilter: string | null;
  ip: string;
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

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/events' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const apiKey = url.searchParams.get('apiKey');
    const contractFilter = url.searchParams.get('contract');
    const eventTypeFilter = url.searchParams.get('eventType');
    const ip = getClientIp(req);

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

    const client: Client = { ws, contractFilter: contractFilter ?? null, eventTypeFilter: eventTypeFilter ?? null, ip };
    clients.add(client);

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return wss;
}

export function broadcastEvent(event: {
  id: string;
  contractAddress: string;
  eventType: string;
  decoded: unknown;
  ledger: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}) {
  const payload = JSON.stringify({ type: 'event', data: event });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.contractFilter && client.contractFilter !== event.contractAddress) continue;
    if (client.eventTypeFilter && client.eventTypeFilter !== event.eventType) continue;
    client.ws.send(payload);
  }
}

export function shutdownWebSocketServer(): void {
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(1001, 'Server shutting down');
    }
  }
  clients.clear();
}

export function broadcastEmergencyEvent(payload: { event: string; data: Record<string, unknown> }) {
  const msg = JSON.stringify({ type: 'emergency', ...payload });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    client.ws.send(msg);
  }
}
