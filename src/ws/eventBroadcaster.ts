import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';

// Each client can subscribe to a specific contract address or event type, or leave them unset for all events
interface Client {
  ws: WebSocket;
  contractFilter: string | null; // null = all contracts
  eventTypeFilter: string | null; // null = all event types
}

const clients = new Set<Client>();

export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/events' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Optional query params: ?contract=CXXX... to filter by contract and ?eventType=token_transfer to filter by event type
    const url = new URL(req.url ?? '', 'http://localhost');
    const contractFilter = url.searchParams.get('contract');
    const eventTypeFilter = url.searchParams.get('eventType');

    const client: Client = { ws, contractFilter, eventTypeFilter };
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
