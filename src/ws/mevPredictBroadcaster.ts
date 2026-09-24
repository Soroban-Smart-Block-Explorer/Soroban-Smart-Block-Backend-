/**
 * WebSocket broadcaster for the forward-looking MEV prediction stream.
 * Path: /ws/mev/predictions
 *
 * Delivery is push-based: the prediction scanner calls
 * `broadcastMevPrediction` and each connected client receives only the
 * signals matching its filters. Filters (signal types, minimum score,
 * sensitivity, pair, contract address) can be supplied as query params at
 * connect time and updated at runtime via a JSON `config` message.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import {
  MEV_SIGNAL_TYPES,
  MevPrediction,
  MevSignalType,
  generateMevPredictions,
  resolveSensitivity,
} from '../indexer/mev-predictor';
import { logger } from '../logger';

interface PredictClient {
  ws: WebSocket;
  types: MevSignalType[];
  minScore: number;
  sensitivity: number;
  pair: string | null;
  contract: string | null;
}

const clients = new Set<PredictClient>();
let wss: WebSocketServer | null = null;

function parseTypes(raw: string | null): MevSignalType[] {
  if (!raw) return [...MEV_SIGNAL_TYPES];
  const requested = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is MevSignalType => (MEV_SIGNAL_TYPES as string[]).includes(t));
  return requested.length > 0 ? requested : [...MEV_SIGNAL_TYPES];
}

function parseScore(raw: string | null, fallback = 0): number {
  const parsed = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, parsed));
}

export function attachMevPredictWebSocket(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws/mev/predictions' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const client: PredictClient = {
      ws,
      types: parseTypes(url.searchParams.get('types')),
      minScore: parseScore(url.searchParams.get('minScore')),
      sensitivity: resolveSensitivity(url.searchParams.get('sensitivity') ?? undefined),
      pair: url.searchParams.get('pair'),
      contract: url.searchParams.get('contract'),
    };
    clients.add(client);

    ws.send(
      JSON.stringify({
        event: 'connected',
        data: {
          message: 'MEV prediction stream connected',
          filters: {
            types: client.types,
            minScore: client.minScore,
            sensitivity: client.sensitivity,
            pair: client.pair,
            contract: client.contract,
          },
        },
      }),
    );

    ws.on('message', (raw: Buffer | string) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type !== 'config' && message.type !== 'subscribe') return;
        if (message.types !== undefined) {
          client.types = Array.isArray(message.types)
            ? parseTypes((message.types as unknown[]).map(String).join(','))
            : parseTypes(String(message.types));
        }
        if (message.minScore !== undefined) {
          client.minScore = parseScore(String(message.minScore), client.minScore);
        }
        if (message.sensitivity !== undefined) {
          client.sensitivity = resolveSensitivity(String(message.sensitivity));
        }
        if (message.pair !== undefined) client.pair = message.pair ? String(message.pair) : null;
        if (message.contract !== undefined) {
          client.contract = message.contract ? String(message.contract) : null;
        }
        ws.send(
          JSON.stringify({
            event: 'config_updated',
            data: { types: client.types, minScore: client.minScore },
          }),
        );
      } catch {
        // Ignore malformed control frames.
      }
    });

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return wss;
}

function matches(client: PredictClient, prediction: MevPrediction): boolean {
  if (!client.types.includes(prediction.type)) return false;
  if (prediction.score < client.minScore) return false;
  if (client.pair && prediction.target.pair !== client.pair) return false;
  if (client.contract && prediction.target.contractAddress !== client.contract) return false;
  return true;
}

/** Broadcast a single ranked prediction to all matching subscribers. */
export function broadcastMevPrediction(prediction: MevPrediction): number {
  const payload = JSON.stringify({ event: 'mev_prediction', data: prediction });
  let delivered = 0;
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!matches(client, prediction)) continue;
    client.ws.send(payload);
    delivered++;
  }
  return delivered;
}

export function broadcastMevPredictions(predictions: MevPrediction[]): number {
  let delivered = 0;
  for (const prediction of predictions) delivered += broadcastMevPrediction(prediction);
  return delivered;
}

export function getMevPredictWsClientCount(): number {
  return clients.size;
}

// ─── Background publisher ─────────────────────────────────────────────────────

const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;

/** Last broadcast score per prediction id — used to emit only fresh signals. */
const seenScores = new Map<string, number>();
let publishInterval: NodeJS.Timeout | null = null;

/**
 * Pure dedup helper: returns predictions that are new or whose score changed
 * since the last tick, updating the `seen` map in place.
 */
export function selectNewPredictions(
  seen: Map<string, number>,
  predictions: MevPrediction[],
): MevPrediction[] {
  const fresh: MevPrediction[] = [];
  for (const prediction of predictions) {
    if (seen.get(prediction.id) !== prediction.score) fresh.push(prediction);
    seen.set(prediction.id, prediction.score);
  }
  return fresh;
}

/**
 * Periodically recompute ranked predictions and push fresh signals to
 * subscribers. Only signals that are new or have changed score are broadcast.
 * Gated by ENABLE_MEV_PREDICT_WS; started from services.ts.
 */
export function startMevPredictionPublisher(
  intervalMs = Number(process.env.MEV_PREDICT_INTERVAL_MS ?? DEFAULT_PUBLISH_INTERVAL_MS),
): void {
  if (publishInterval) return;
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_PUBLISH_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    try {
      const result = await generateMevPredictions({});
      broadcastMevPredictions(selectNewPredictions(seenScores, result.predictions));
    } catch (err) {
      logger.warn('MEV prediction publish tick failed', { error: String(err) });
    }
  };

  publishInterval = setInterval(() => void tick(), interval);
  // Never keep the process alive purely for the publisher.
  publishInterval.unref?.();
}

export function stopMevPredictionPublisher(): void {
  if (publishInterval) {
    clearInterval(publishInterval);
    publishInterval = null;
  }
  seenScores.clear();
}
