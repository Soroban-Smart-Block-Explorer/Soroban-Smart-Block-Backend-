/**
 * Freeze incident alert channel API (VE05): recent feed, SSE stream, webhook subscriptions.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';
import {
  freezeIncidentChannel,
  FreezeIncident,
} from '../indexer/freeze-incident-channel';

export const freezeIncidentsRouter = Router();
freezeIncidentsRouter.use(adminAuth);

const severity = z.enum(['low', 'medium', 'high', 'critical']);

freezeIncidentsRouter.get('/', (req: Request, res: Response) => {
  const q = z
    .object({ minSeverity: severity.default('low'), limit: z.coerce.number().int().min(1).max(200).default(50) })
    .safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.flatten() });
  const incidents = freezeIncidentChannel.listRecent(q.data.minSeverity, q.data.limit);
  res.json({ incidents, total: incidents.length });
});

freezeIncidentsRouter.get('/stream', (req: Request, res: Response) => {
  const q = z.object({ minSeverity: severity.default('low') }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: q.error.flatten() });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  const onIncident = (incident: FreezeIncident) => {
    if (!freezeIncidentChannel.meetsSeverity(incident, q.data.minSeverity)) return;
    res.write(`event: freeze_incident\nid: ${incident.id}\ndata: ${JSON.stringify(incident)}\n\n`);
  };
  freezeIncidentChannel.events.on('incident', onIncident);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    freezeIncidentChannel.events.off('incident', onIncident);
  });
});

freezeIncidentsRouter.get('/subscriptions', (_req: Request, res: Response) => {
  res.json({ subscriptions: freezeIncidentChannel.listWebhooks() });
});

freezeIncidentsRouter.post('/subscriptions', (req: Request, res: Response) => {
  const body = z
    .object({ url: z.string().url().refine((u) => u.startsWith('https://'), 'https required'), minSeverity: severity.default('high') })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  res.status(201).json(freezeIncidentChannel.addWebhook(body.data.url, body.data.minSeverity));
});

freezeIncidentsRouter.delete('/subscriptions/:id', (req: Request, res: Response) => {
  if (!freezeIncidentChannel.removeWebhook(req.params.id)) {
    return res.status(404).json({ error: 'Subscription not found' });
  }
  res.status(204).end();
});
