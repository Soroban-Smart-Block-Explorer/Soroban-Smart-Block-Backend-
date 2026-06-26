import { Router, Request, Response } from 'express';
import { createHmac, randomBytes } from 'crypto';
import axios from 'axios';
import { prismaWrite as prisma } from '../db';
import { requireAuth } from '../auth/middleware';

export const authWebhooksRouter = Router();

export async function deliverWebhookEvent(
  userId: string,
  eventName: string,
  payload: object
): Promise<void> {
  const hooks = await prisma.authWebhook.findMany({
    where: { userId, isActive: true },
  });

  for (const hook of hooks) {
    const events = hook.events as string[];
    if (!events.includes(eventName) && !events.includes('*')) continue;

    const body = JSON.stringify({
      event: eventName,
      ...payload,
      timestamp: new Date().toISOString(),
    });
    const sig = createHmac('sha256', hook.secret).update(body).digest('hex');

    axios.post(hook.url, JSON.parse(body), {
      headers: { 'X-Webhook-Signature': `sha256=${sig}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    }).catch(() => {/* non-blocking; could add retry queue */});
  }
}

authWebhooksRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const { url, events, secret } = req.body ?? {};
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: 'url and events[] required' });
  }

  const hook = await prisma.authWebhook.create({
    data: {
      userId: req.user!.id,
      url,
      events,
      secret: secret ?? randomBytes(24).toString('hex'),
    },
  });
  res.status(201).json({ id: hook.id, url: hook.url, events: hook.events, createdAt: hook.createdAt });
});

authWebhooksRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const hooks = await prisma.authWebhook.findMany({
    where: { userId: req.user!.id },
    select: { id: true, url: true, events: true, isActive: true, createdAt: true },
  });
  res.json({ webhooks: hooks });
});

authWebhooksRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const hook = await prisma.authWebhook.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });
  await prisma.authWebhook.update({ where: { id: hook.id }, data: { isActive: false } });
  res.json({ success: true });
});

authWebhooksRouter.post('/:id/test', requireAuth, async (req: Request, res: Response) => {
  const hook = await prisma.authWebhook.findFirst({
    where: { id: req.params.id, userId: req.user!.id, isActive: true },
  });
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });

  const testPayload = {
    event: 'test',
    userId: req.user!.id,
    address: req.user!.address,
    message: 'This is a test event from Soroban Explorer',
  };
  const body = JSON.stringify({ ...testPayload, timestamp: new Date().toISOString() });
  const sig = createHmac('sha256', hook.secret).update(body).digest('hex');

  try {
    await axios.post(hook.url, JSON.parse(body), {
      headers: { 'X-Webhook-Signature': `sha256=${sig}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    res.json({ success: true, status: 'delivered' });
  } catch (err) {
    res.status(502).json({ success: false, error: 'Webhook delivery failed' });
  }
});
