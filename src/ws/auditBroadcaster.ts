/**
 * Audit Score WebSocket Broadcaster
 * Path: /ws/audit
 *
 * Clients connect and optionally filter by contractAddress.
 * Pushed event types:
 *   score_alert        — score dropped by threshold or more
 *   finding_alert      — new critical/high finding discovered
 *   certificate_update — new certificate published
 *   signal_detected    — real-time monitoring signal (before full re-audit)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';

// ── Client registry ───────────────────────────────────────────────────────────

interface AuditClient {
  ws: WebSocket;
  contractFilter: string | null; // null = all contracts
  minScoreDrop: number; // only alert if drop >= this (default 10)
  severityFilter: string[]; // ['critical','high'] = only these
}

const clients = new Set<AuditClient>();
let wss: WebSocketServer | null = null;

// ── Attach ────────────────────────────────────────────────────────────────────

export function attachAuditWebSocket(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws/audit' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const contractFilter = url.searchParams.get('contract') ?? null;
    const minScoreDrop = Math.max(1, parseInt(url.searchParams.get('minDrop') ?? '10'));
    const sevParam = url.searchParams.get('severity') ?? 'critical,high';
    const severityFilter = sevParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const client: AuditClient = { ws, contractFilter, minScoreDrop, severityFilter };
    clients.add(client);

    ws.send(
      JSON.stringify({
        type: 'connected',
        data: {
          message: 'Audit monitoring stream connected.',
          filters: { contractFilter, minScoreDrop, severityFilter },
          subscribedEvents: [
            'score_alert',
            'finding_alert',
            'certificate_update',
            'signal_detected',
          ],
        },
      }),
    );

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return wss;
}

export function getAuditWsClientCount(): number {
  return clients.size;
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function send(client: AuditClient, payload: string): void {
  try {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
  } catch {
    /* ignore closed sockets */
  }
}

// ── Score drop alert ──────────────────────────────────────────────────────────

export interface ScoreAlertPayload {
  contractAddress: string;
  previousScore: number;
  newScore: number;
  drop: number;
  trigger: string;
  certId: string;
  version: number;
  riskLevel: string;
  detectedAt: string;
}

export function broadcastScoreAlert(alert: ScoreAlertPayload): void {
  const payload = JSON.stringify({ type: 'score_alert', data: alert });
  for (const client of clients) {
    if (client.contractFilter && client.contractFilter !== alert.contractAddress) continue;
    if (alert.drop < client.minScoreDrop) continue;
    send(client, payload);
  }
}

// ── New finding alert ─────────────────────────────────────────────────────────

export interface FindingAlertPayload {
  contractAddress: string;
  certId: string;
  findingId: string;
  severity: string;
  category: string;
  title: string;
  cweId: string | null;
  cvssScore: number | null;
  detectedAt: string;
}

export function broadcastFindingAlert(alert: FindingAlertPayload): void {
  const payload = JSON.stringify({ type: 'finding_alert', data: alert });
  for (const client of clients) {
    if (client.contractFilter && client.contractFilter !== alert.contractAddress) continue;
    if (!client.severityFilter.includes(alert.severity)) continue;
    send(client, payload);
  }
}

// ── Certificate published ─────────────────────────────────────────────────────

export interface CertUpdatePayload {
  contractAddress: string;
  certId: string;
  version: number;
  overallScore: number;
  grade: string;
  riskLevel: string;
  totalFindings: number;
  criticalFindings: number;
  trigger: string;
  generatedAt: string;
  verifyUrl: string;
}

export function broadcastCertificateUpdate(update: CertUpdatePayload): void {
  const payload = JSON.stringify({ type: 'certificate_update', data: update });
  for (const client of clients) {
    if (client.contractFilter && client.contractFilter !== update.contractAddress) continue;
    send(client, payload);
  }
}

// ── Real-time signal (pre-audit detection) ────────────────────────────────────

export interface SignalPayload {
  contractAddress: string;
  signalType: string; // see MonitorSignalType in audit-monitor.ts
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  detail: Record<string, unknown>;
  willTriggerAudit: boolean;
  detectedAt: string;
}

export function broadcastSignal(signal: SignalPayload): void {
  const payload = JSON.stringify({ type: 'signal_detected', data: signal });
  for (const client of clients) {
    if (client.contractFilter && client.contractFilter !== signal.contractAddress) continue;
    if (!client.severityFilter.includes(signal.severity)) continue;
    send(client, payload);
  }
}

// ── Certificate expiry alert ──────────────────────────────────────────────────

export interface CertExpiryPayload {
  contractAddress: string;
  certId: string;
  certificateHash: string;
  version: number;
  expiresAt: string;
  daysRemaining: number;
  urgency: 'warning' | 'urgent' | 'critical'; // 30d / 14d / 7d
  renewUrl: string;
}

export function broadcastCertExpiry(alert: CertExpiryPayload): void {
  const payload = JSON.stringify({ type: 'certificate_expiry', data: alert });
  for (const client of clients) {
    if (client.contractFilter && client.contractFilter !== alert.contractAddress) continue;
    // Always send expiry alerts regardless of severityFilter
    send(client, payload);
  }
}
