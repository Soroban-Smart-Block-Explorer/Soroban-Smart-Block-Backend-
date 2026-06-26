import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';

interface ComposabilityClient {
  ws: WebSocket;
  contractFilter: string | null;
  minSeverity: 'low' | 'medium' | 'high' | 'critical';
}

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

const clients = new Set<ComposabilityClient>();

export function attachComposabilityWebSocket(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/composability/exploits' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const contractFilter = url.searchParams.get('contract');
    const minSeverityParam = url.searchParams.get('minSeverity') as
      | 'low'
      | 'medium'
      | 'high'
      | 'critical'
      | null;
    const minSeverity: 'low' | 'medium' | 'high' | 'critical' = minSeverityParam ?? 'low';

    const client: ComposabilityClient = { ws, contractFilter, minSeverity };
    clients.add(client);

    ws.send(JSON.stringify({ type: 'connected', path: '/ws/composability/exploits' }));

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return wss;
}

export function broadcastExploitAlert(alert: {
  txHash?: string;
  contractAddress?: string;
  exploitType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  description: string;
  patterns: string[];
  mitigationPatch?: Record<string, unknown>;
  timestamp: Date;
}) {
  const payload = JSON.stringify({ type: 'exploit_alert', data: alert });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (
      client.contractFilter &&
      alert.contractAddress &&
      client.contractFilter !== alert.contractAddress
    )
      continue;
    if (SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[client.minSeverity]) continue;
    client.ws.send(payload);
  }
}

export function broadcastCompositionAnalyzed(result: {
  txHash: string;
  safetyScore: number;
  riskLevel: string;
  patternCount: number;
  timestamp: Date;
}) {
  const payload = JSON.stringify({ type: 'composition_analyzed', data: result });
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    client.ws.send(payload);
  }
}
