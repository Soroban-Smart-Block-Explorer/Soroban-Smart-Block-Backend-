import { Router, Request, Response } from 'express';
import { realtimeHub, RealtimeMessage, ContractEventPayload } from '../realtime/eventHub';
import { logger } from '../logger';

export const realtimeSSERouter = Router();

const HEARTBEAT_MS = 15000;
const MAX_CONNECTIONS_PER_CLIENT = Number(process.env.REALTIME_MAX_SSE_PER_CLIENT ?? 5);
const MAX_PENDING_BYTES = 1024 * 1024;
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

const connectionsByClient = new Map<string, number>();

function openStream(
  req: Request,
  res: Response,
  filter: (message: RealtimeMessage) => boolean,
): void {
  const clientKey = req.ip ?? 'unknown';
  const active = connectionsByClient.get(clientKey) ?? 0;
  if (active >= MAX_CONNECTIONS_PER_CLIENT) {
    res.status(429).json({ error: 'Too many realtime connections' });
    return;
  }
  connectionsByClient.set(clientKey, active + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  const send = (message: RealtimeMessage) => {
    if (!filter(message)) return;
    // Drop slow consumers instead of buffering unboundedly.
    if (res.writableLength > MAX_PENDING_BYTES) {
      logger.warn('Realtime SSE consumer too slow, closing', { clientKey });
      res.end();
      return;
    }
    res.write(`id: ${message.id}\nevent: ${message.topic}\ndata: ${JSON.stringify(message)}\n\n`);
  };

  const lastEventId = Number(req.headers['last-event-id'] ?? req.query.lastEventId);
  if (Number.isInteger(lastEventId) && lastEventId >= 0) {
    realtimeHub.since(lastEventId).forEach(send);
  }

  const unsubscribe = realtimeHub.subscribe(send);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    const remaining = (connectionsByClient.get(clientKey) ?? 1) - 1;
    if (remaining <= 0) connectionsByClient.delete(clientKey);
    else connectionsByClient.set(clientKey, remaining);
  });
}

/** GET /realtime/ledgers — stream of newly indexed ledgers. */
realtimeSSERouter.get('/ledgers', (req, res) => {
  openStream(req, res, (m) => m.topic === 'ledger');
});

/** GET /realtime/contracts/:address/events?types=a,b — decoded events for one contract. */
realtimeSSERouter.get('/contracts/:address/events', (req, res) => {
  const { address } = req.params;
  if (!CONTRACT_ADDRESS_RE.test(address)) {
    res.status(400).json({ error: 'Invalid contract address' });
    return;
  }
  const types =
    typeof req.query.types === 'string' ? req.query.types.split(',').filter(Boolean) : [];
  if (types.length > 20) {
    res.status(400).json({ error: 'Too many event types (max 20)' });
    return;
  }
  openStream(req, res, (m) => {
    if (m.topic !== 'contract_event') return false;
    const event = m.payload as ContractEventPayload;
    return event.contractId === address && (types.length === 0 || types.includes(event.eventType));
  });
});
