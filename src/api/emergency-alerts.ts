import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import https from 'https';
import http from 'http';

export const alertConfigRouter = Router();

const channelSchema = z.object({
  type: z.enum(['email', 'slack', 'discord', 'telegram', 'webhook', 'pagerduty']),
  config: z.record(z.unknown()),
});

const createAlertSchema = z.object({
  userId: z.string().min(1),
  name: z.string().optional(),
  contractAddress: z.string().optional(),
  alertType: z.string().min(1),
  conditions: z.record(z.unknown()).optional(),
  channels: z.array(channelSchema).min(1),
  cooldownMinutes: z.coerce.number().int().min(0).default(60),
});

// POST /emergency/alerts
alertConfigRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = createAlertSchema.parse(req.body);
    const alert = await prismaWrite.alertConfiguration.create({
      data: {
        userId: data.userId,
        name: data.name,
        contractAddress: data.contractAddress,
        alertType: data.alertType,
        conditions: (data.conditions ?? null) as object,
        channels: data.channels as object,
        cooldownMinutes: data.cooldownMinutes,
      },
    });
    res.status(201).json(alert);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
});

// GET /emergency/alerts
alertConfigRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const alerts = await prismaRead.alertConfiguration.findMany({
      where: { ...(userId ? { userId } : {}), isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: alerts, total: alerts.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /emergency/alerts/:id
alertConfigRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const patch = z
      .object({
        name: z.string().optional(),
        isActive: z.boolean().optional(),
        conditions: z.record(z.unknown()).optional(),
        channels: z.array(channelSchema).optional(),
        cooldownMinutes: z.coerce.number().int().optional(),
      })
      .parse(req.body);

    const updated = await prismaWrite.alertConfiguration.update({
      where: { id: req.params.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.conditions ? { conditions: patch.conditions as object } : {}),
        ...(patch.channels ? { channels: patch.channels as object } : {}),
        ...(patch.cooldownMinutes !== undefined ? { cooldownMinutes: patch.cooldownMinutes } : {}),
      },
    });
    res.json(updated);
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: String(err) });
  }
});

// DELETE /emergency/alerts/:id
alertConfigRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prismaWrite.alertConfiguration.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.status(204).send();
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: String(err) });
  }
});

// POST /emergency/alerts/:id/test
alertConfigRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const alert = await prismaRead.alertConfiguration.findUnique({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Not found' });

    const channels = alert.channels as Array<{ type: string; config: Record<string, unknown> }>;
    const results: Array<{ type: string; success: boolean; error?: string }> = [];

    for (const ch of channels) {
      try {
        await deliverAlert(ch, {
          alertType: alert.alertType,
          contract: alert.contractAddress ?? 'TEST',
          message: `Test alert from Emergency Response Platform for alert "${alert.name ?? alert.id}"`,
          timestamp: new Date().toISOString(),
        });
        results.push({ type: ch.type, success: true });
      } catch (e) {
        results.push({ type: ch.type, success: false, error: String(e) });
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Fire alerts for a pause event — called by the emergency indexer */
export async function fireAlertsForPause(
  contractAddress: string,
  severity: string,
  reason?: string | null,
): Promise<void> {
  const now = new Date();
  const alerts = await prismaRead.alertConfiguration.findMany({
    where: {
      isActive: true,
      alertType: 'pause_detected',
      OR: [{ contractAddress }, { contractAddress: null }],
    },
  });

  for (const alert of alerts) {
    // Respect cooldown
    if (alert.lastTriggeredAt) {
      const cooldownMs = alert.cooldownMinutes * 60_000;
      if (now.getTime() - alert.lastTriggeredAt.getTime() < cooldownMs) continue;
    }

    const conditions = alert.conditions as Record<string, unknown> | null;
    if (conditions?.minSeverity) {
      const levels = ['low', 'medium', 'high', 'critical'];
      if (levels.indexOf(severity) < levels.indexOf(conditions.minSeverity as string)) continue;
    }

    const channels = alert.channels as Array<{ type: string; config: Record<string, unknown> }>;
    for (const ch of channels) {
      await deliverAlert(ch, {
        alertType: 'pause_detected',
        contract: contractAddress,
        severity,
        message: `Contract ${contractAddress} has been paused. Severity: ${severity}. ${reason ? `Reason: ${reason}` : ''}`,
        timestamp: now.toISOString(),
      }).catch(() => null);
    }

    await prismaWrite.alertConfiguration.update({
      where: { id: alert.id },
      data: { lastTriggeredAt: now },
    });
  }
}

async function deliverAlert(
  channel: { type: string; config: Record<string, unknown> },
  payload: Record<string, unknown>,
): Promise<void> {
  switch (channel.type) {
    case 'slack':
    case 'discord': {
      const webhookUrl = channel.config.webhookUrl as string;
      if (!webhookUrl) throw new Error('Missing webhookUrl');
      await postJson(webhookUrl, {
        text: payload.message,
        username: 'Emergency Monitor',
        attachments: [
          {
            color: 'danger',
            fields: Object.entries(payload).map(([k, v]) => ({
              title: k,
              value: String(v),
              short: true,
            })),
          },
        ],
      });
      break;
    }
    case 'webhook': {
      const url = channel.config.url as string;
      if (!url) throw new Error('Missing url');
      await postJson(url, payload);
      break;
    }
    case 'email':
    case 'telegram':
    case 'pagerduty':
      // Log only — external integrations require API keys not available in this env
      console.info(`[Alert] ${channel.type} delivery: ${JSON.stringify(payload)}`);
      break;
  }
}

function postJson(url: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
