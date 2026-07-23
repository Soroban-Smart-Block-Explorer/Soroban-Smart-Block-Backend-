import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';

interface PrivacyClient {
  ws: WebSocket;
  filters: {
    minValue?: number;
    protocols?: string[];
    minAnonymitySet?: number;
    minConfidence?: number;
  };
}

const privacyClients = new Set<PrivacyClient>();
const alertClients = new Set<WebSocket>();

export function attachPrivacyWebSocket(httpServer: Server): {
  privacyWss: WebSocketServer;
  alertWss: WebSocketServer;
} {
  const privacyWss = new WebSocketServer({ noServer: true });
  const alertWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === '/ws/v1/privacy/alerts') {
      alertWss.handleUpgrade(req, socket, head, (ws) => alertWss.emit('connection', ws, req));
    } else if (pathname === '/ws/v1/privacy') {
      privacyWss.handleUpgrade(req, socket, head, (ws) => privacyWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  privacyWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const filters: PrivacyClient['filters'] = {};
    if (url.searchParams.get('minValue'))
      filters.minValue = Number(url.searchParams.get('minValue'));
    if (url.searchParams.get('protocols'))
      filters.protocols = url.searchParams.get('protocols')!.split(',');
    if (url.searchParams.get('minAnonymitySet'))
      filters.minAnonymitySet = Number(url.searchParams.get('minAnonymitySet'));
    if (url.searchParams.get('minConfidence'))
      filters.minConfidence = Number(url.searchParams.get('minConfidence'));

    const client: PrivacyClient = { ws, filters };
    privacyClients.add(client);
    ws.on('close', () => privacyClients.delete(client));
    ws.on('error', () => privacyClients.delete(client));
  });

  alertWss.on('connection', (ws: WebSocket) => {
    alertClients.add(ws);
    ws.on('close', () => alertClients.delete(ws));
    ws.on('error', () => alertClients.delete(ws));
  });

  return { privacyWss, alertWss };
}

export function broadcastPrivacyTransaction(data: {
  txHash: string;
  protocols: string[];
  privacyScore?: number | null;
  riskScore?: number | null;
  anonymitySetSize?: number | null;
  totalValue?: string | null;
  usdValue?: number | null;
  participants: string[];
  timestamp: Date;
}) {
  const payload = JSON.stringify({ type: 'privacy_transaction', data });

  for (const client of privacyClients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.filters.minValue && data.usdValue && data.usdValue < client.filters.minValue)
      continue;
    if (
      client.filters.protocols &&
      !data.protocols.some((p) => client.filters.protocols!.includes(p))
    )
      continue;
    if (
      client.filters.minAnonymitySet &&
      (data.anonymitySetSize ?? 0) < client.filters.minAnonymitySet
    )
      continue;
    client.ws.send(payload);
  }
}

export function broadcastPrivacyAlert(alert: {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  txHash?: string;
  address?: string;
  confidence?: number;
  timestamp: Date;
}) {
  const payload = JSON.stringify({ type: 'alert', data: alert });

  for (const ws of alertClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}
