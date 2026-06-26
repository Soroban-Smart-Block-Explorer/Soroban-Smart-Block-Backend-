import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';

export const alertsRouter = Router();

const ALERT_TYPES = ['above', 'below', 'change_pct', 'peg_deviation', 'volume_spike'] as const;

const createAlertSchema = z.object({
  tokenAddress: z.string().min(1),
  alertType: z.enum(ALERT_TYPES),
  threshold: z.string().min(1),
  timeWindow: z.string().optional(),
  userId: z.string().optional(),
});

const updateAlertSchema = z.object({
  threshold: z.string().optional(),
  timeWindow: z.string().optional(),
  isActive: z.boolean().optional(),
});

alertsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const data = createAlertSchema.parse(req.body);
    const userId = data.userId ?? (req.headers['x-user-id'] as string | undefined);

    const token = await prismaRead.contract.findFirst({
      where: { address: data.tokenAddress, isToken: true },
    });
    if (!token) throw new AppError(404, 'Token not found');

    const alert = await prismaWrite.priceAlert.create({
      data: {
        tokenAddress: data.tokenAddress,
        alertType: data.alertType,
        threshold: data.threshold,
        timeWindow: data.timeWindow ?? null,
        userId: userId ?? null,
      },
    });

    res.status(201).json(alert);
  }),
);

alertsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.query.userId as string | undefined;
    const where = userId ? { userId } : {};

    const alerts = await prismaRead.priceAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ alerts });
  }),
);

alertsRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = updateAlertSchema.parse(req.body);

    const existing = await prismaRead.priceAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Alert not found');

    const alert = await prismaWrite.priceAlert.update({
      where: { id },
      data: {
        ...(data.threshold !== undefined && { threshold: data.threshold }),
        ...(data.timeWindow !== undefined && { timeWindow: data.timeWindow }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    res.json(alert);
  }),
);

alertsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const existing = await prismaRead.priceAlert.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Alert not found');

    await prismaWrite.priceAlert.delete({ where: { id } });

    res.status(204).send();
  }),
);

export async function checkAndFireAlerts(
  tokenAddress: string,
  currentPrice: number,
): Promise<void> {
  const activeAlerts = await prismaRead.priceAlert.findMany({
    where: { tokenAddress, isActive: true },
  });

  const now = new Date();
  const cooldownMs = 15 * 60 * 1000;

  for (const alert of activeAlerts) {
    if (alert.lastTriggeredAt && now.getTime() - alert.lastTriggeredAt.getTime() < cooldownMs) {
      continue;
    }

    let shouldFire = false;
    const threshold = parseFloat(alert.threshold);

    switch (alert.alertType) {
      case 'above':
        shouldFire = currentPrice > threshold;
        break;
      case 'below':
        shouldFire = currentPrice < threshold;
        break;
      case 'change_pct': {
        const windowMs = parseTimeWindow(alert.timeWindow ?? '1h');
        const cutoff = new Date(now.getTime() - windowMs);
        const history = await prismaRead.tokenPriceHistory.findFirst({
          where: { tokenAddress, timestamp: { lte: cutoff } },
          orderBy: { timestamp: 'desc' },
          select: { priceUsd: true },
        });
        if (history) {
          const changePct =
            Math.abs((currentPrice - Number(history.priceUsd)) / Number(history.priceUsd)) * 100;
          shouldFire = changePct > threshold;
        }
        break;
      }
      case 'peg_deviation': {
        const marketData = await prismaRead.tokenMarketData.findUnique({ where: { tokenAddress } });
        if (marketData?.pegDeviation24h != null) {
          shouldFire = marketData.pegDeviation24h * 100 > threshold;
        }
        break;
      }
      case 'volume_spike': {
        const tokenPrice = await prismaRead.tokenPrice.findUnique({ where: { tokenAddress } });
        if (tokenPrice?.volume24hUsd) {
          const avgVolume = await getAverageVolume(tokenAddress);
          if (avgVolume > 0) {
            shouldFire = Number(tokenPrice.volume24hUsd) / avgVolume > threshold;
          }
        }
        break;
      }
    }

    if (shouldFire) {
      await prismaWrite.priceAlert.update({
        where: { id: alert.id },
        data: { lastTriggeredAt: now },
      });
      await deliverAlert(alert, currentPrice);
    }
  }
}

function parseTimeWindow(window: string): number {
  const match = window.match(/^(\d+)([mhdw])$/);
  if (!match) return 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return value * (multipliers[unit] ?? 60 * 60 * 1000);
}

async function getAverageVolume(tokenAddress: string): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const history = await prismaRead.tokenPriceHistory.findMany({
    where: { tokenAddress, timestamp: { gte: cutoff }, volume24hUsd: { not: null } },
    select: { volume24hUsd: true },
  });
  if (history.length === 0) return 0;
  const volumes = history.map((h) => Number(h.volume24hUsd));
  return volumes.reduce((s, v) => s + v, 0) / volumes.length;
}

async function deliverAlert(
  alert: { tokenAddress: string; alertType: string; threshold: string; userId?: string | null },
  price: number,
): Promise<void> {
  console.log(
    `[Alert] Firing alert for ${alert.tokenAddress}: ${alert.alertType} at threshold ${alert.threshold}, current price ${price}`,
  );

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenAddress: alert.tokenAddress,
          alertType: alert.alertType,
          threshold: alert.threshold,
          currentPrice: price,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.error('[Alert] Webhook delivery failed:', err);
    }
  }

  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    try {
      await fetch(slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Price Alert: ${alert.tokenAddress}\nType: ${alert.alertType}\nThreshold: ${alert.threshold}\nCurrent Price: ${price}`,
        }),
      });
    } catch {
      // ignore
    }
  }
}
