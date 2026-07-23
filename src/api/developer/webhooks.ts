import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaWrite, prismaRead } from '../../db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { redactSensitiveData } from '../../webhooks/redaction';

export const devWebhooksRouter = Router();

const isAllowedUrl = (raw: string): boolean => {
  try {
    const parsed = new URL(raw);
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1';
    return parsed.protocol === 'https:' || (isLocal && process.env.NODE_ENV !== 'production');
  } catch {
    return false;
  }
};

const httpsUrl = z
  .string()
  .url()
  .refine(isAllowedUrl, { message: 'Webhook URL must use HTTPS' });

const createWebhookSchema = z.object({
  developerId: z.string(),
  url: httpsUrl,
  events: z.array(z.string()).min(1),
  retryPolicy: z.object({ maxRetries: z.number().int(), backoffMs: z.number().int() }).optional(),
  headers: z.record(z.string()).optional(),
});

const updateWebhookSchema = z.object({
  url: httpsUrl.optional(),
  events: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  retryPolicy: z.object({ maxRetries: z.number().int(), backoffMs: z.number().int() }).optional(),
  headers: z.record(z.string()).optional(),
});

// POST /developer/webhooks
devWebhooksRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { developerId, url, events, retryPolicy, headers } = parsed.data;

    const developer = await prismaRead.developer.findUnique({ where: { id: developerId } });
    if (!developer) return res.status(404).json({ error: 'Developer not found' });

    const secret = crypto.randomBytes(32).toString('hex');

    const webhook = await prismaWrite.devWebhook.create({
      data: {
        developerId,
        url,
        secret,
        events: events as Prisma.InputJsonValue,
        retryPolicy: retryPolicy
          ? (retryPolicy as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        headers: headers ? (headers as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      select: { id: true, url: true, events: true, active: true, createdAt: true, secret: true },
    });

    res.status(201).json(webhook);
  }),
);

// GET /developer/webhooks
devWebhooksRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const webhooks = await prismaRead.devWebhook.findMany({
      where: { developerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        lastDeliveryAt: true,
        lastDeliveryStatus: true,
        createdAt: true,
      },
    });

    res.json({ data: webhooks });
  }),
);

// PATCH /developer/webhooks/:id
devWebhooksRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);
    const parsed = updateWebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const existing = await prismaRead.devWebhook.findFirst({
      where: { id: req.params.id, developerId },
    });
    if (!existing) return res.status(404).json({ error: 'Webhook not found' });

    const webhook = await prismaWrite.devWebhook.update({
      where: { id: req.params.id },
      data: parsed.data,
      select: { id: true, url: true, events: true, active: true, updatedAt: true },
    });

    res.json(webhook);
  }),
);

// DELETE /developer/webhooks/:id
devWebhooksRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const existing = await prismaRead.devWebhook.findFirst({
      where: { id: req.params.id, developerId },
    });
    if (!existing) return res.status(404).json({ error: 'Webhook not found' });

    await prismaWrite.devWebhook.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

// POST /developer/webhooks/:id/test
devWebhooksRouter.post(
  '/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);

    const webhook = await prismaRead.devWebhook.findFirst({
      where: { id: req.params.id, developerId },
    });
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    const payload = { type: 'test', timestamp: new Date().toISOString(), webhookId: webhook.id };
    const start = Date.now();

    const expiresAt = new Date(Date.now() + webhook.responseRetentionDays * 24 * 60 * 60 * 1000);

    const delivery = await prismaWrite.devWebhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: 'test',
        payload,
        attempt: 1,
        delivered: false,
        expiresAt,
      },
      select: { id: true, eventType: true, createdAt: true },
    });

    // Attempt delivery (non-blocking simulation — real implementation would use a queue)
    try {
      const { default: axios } = await import('axios');
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await axios.post(webhook.url, payload, {
        headers: { 'X-Webhook-Signature': signature, 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const durationMs = Date.now() - start;
      const rawResponseBody = String(response.data);
      const processedResponseBody = webhook.storeResponseBody
        ? redactSensitiveData(rawResponseBody.slice(0, 500))
        : null;

      await prismaWrite.devWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: response.status,
          delivered: response.status < 300,
          durationMs,
          deliveredAt: new Date(),
          responseBody: processedResponseBody,
        },
      });
      await prismaWrite.devWebhook.update({
        where: { id: webhook.id },
        data: {
          lastDeliveryAt: new Date(),
          lastDeliveryStatus: response.status < 300 ? 'success' : 'failed',
        },
      });

      return res.json({ success: true, statusCode: response.status, durationMs });
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      const processedError = webhook.storeResponseBody
        ? redactSensitiveData(msg.slice(0, 500))
        : null;

      await prismaWrite.devWebhookDelivery.update({
        where: { id: delivery.id },
        data: { delivered: false, durationMs, responseBody: processedError },
      });
      await prismaWrite.devWebhook.update({
        where: { id: webhook.id },
        data: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'failed' },
      });
      return res.json({ success: false, error: msg, durationMs });
    }
  }),
);

// GET /developer/webhooks/:id/deliveries
devWebhooksRouter.get(
  '/:id/deliveries',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);
    const { includeResponseBody } = z
      .object({ includeResponseBody: z.enum(['true', 'false']).optional() })
      .parse(req.query);

    const webhook = await prismaRead.devWebhook.findFirst({
      where: { id: req.params.id, developerId },
    });
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    const deliveries = await prismaRead.devWebhookDelivery.findMany({
      where: { webhookId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Exclude responseBody by default for security; only include if explicitly requested
    const sanitizedDeliveries = deliveries.map((d) => {
      if (includeResponseBody === 'true') {
        // User explicitly requested response body - include but potentially redacted
        return {
          ...d,
          responseBody: d.responseBody ? redactSensitiveData(d.responseBody) : null,
        };
      }
      // Exclude responseBody by default
      const { responseBody: _responseBody, ...rest } = d;
      return rest;
    });

    res.json({ data: sanitizedDeliveries });
  }),
);

// POST /developer/webhooks/:id/retry
devWebhooksRouter.post(
  '/:id/retry',
  asyncHandler(async (req: Request, res: Response) => {
    const { developerId } = z.object({ developerId: z.string() }).parse(req.query);
    const { deliveryId } = z.object({ deliveryId: z.string() }).parse(req.body);

    const webhook = await prismaRead.devWebhook.findFirst({
      where: { id: req.params.id, developerId },
    });
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    const original = await prismaRead.devWebhookDelivery.findFirst({
      where: { id: deliveryId, webhookId: webhook.id },
    });
    if (!original) return res.status(404).json({ error: 'Delivery not found' });

    const retry = await prismaWrite.devWebhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: original.eventType,
        payload: original.payload as object,
        attempt: original.attempt + 1,
        delivered: false,
      },
      select: { id: true, attempt: true, createdAt: true },
    });

    res.status(202).json({ message: 'Retry queued', delivery: retry });
  }),
);
