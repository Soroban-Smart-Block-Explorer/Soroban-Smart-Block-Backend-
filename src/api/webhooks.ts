import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma, prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';
import { apiKeyAuth, requireApiKey } from '../middleware/apiKeyAuth';
import { assertSafeUrl, SsrfBlockedError } from '../webhooks/ssrf-guard';

export const webhooksRouter = Router();

// Apply API key authentication to every route on this router (#478).
// apiKeyAuth populates req.apiKey; requireApiKey enforces its presence.
webhooksRouter.use(apiKeyAuth, requireApiKey);

// Secret must be at least 32 characters to carry sufficient HMAC entropy (#481).
const MIN_SECRET_LENGTH = 32;

const createSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(MIN_SECRET_LENGTH).optional(),
  contractAddress: z.string().optional(),
  eventType: z.string().optional(),
  topicSymbol: z.string().optional(),
});

/**
 * @swagger
 * /webhooks:
 *   post:
 *     summary: Register a webhook subscription
 *     description: >
 *       Register a server endpoint to receive on-chain contract event
 *       notifications. Each delivery is signed with HMAC-SHA256 using the
 *       signing secret (X-Webhook-Signature header). Failed deliveries are
 *       retried with exponential backoff (up to 5 attempts).
 *       The secret is returned only once in this response — store it securely.
 *     security:
 *       - ApiKeyAuth: []
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 description: HTTPS endpoint to receive webhook payloads
 *               secret:
 *                 type: string
 *                 minLength: 32
 *                 description: >
 *                   Optional signing secret (min 32 chars). If omitted a
 *                   256-bit random secret is generated for you. The value is
 *                   returned only once — it cannot be retrieved again.
 *               contractAddress:
 *                 type: string
 *                 description: Filter to a specific contract (omit for all contracts)
 *               eventType:
 *                 type: string
 *                 description: Filter to a specific event type (e.g. "transfer")
 *               topicSymbol:
 *                 type: string
 *                 description: Filter to a specific topic symbol
 *     responses:
 *       201:
 *         description: Subscription created — includes the signing secret (shown once)
 *       400:
 *         description: Validation error
 *       401:
 *         description: API key required
 */
webhooksRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // SSRF guard: reject URLs that resolve to private/loopback/metadata addresses.
    try {
      await assertSafeUrl(parsed.data.url);
    } catch (err) {
      const message = err instanceof SsrfBlockedError ? err.message : 'Invalid webhook URL';
      return res.status(400).json({ error: message });
    }

    // Generate a high-entropy secret when the caller doesn't supply one (#481).
    const secret = parsed.data.secret ?? crypto.randomBytes(32).toString('hex');

    const sub = await prisma.webhookSubscription.create({
      data: {
        apiKeyId: req.apiKey!.id,
        url: parsed.data.url,
        secret,
        contractAddress: parsed.data.contractAddress,
        eventType: parsed.data.eventType,
        topicSymbol: parsed.data.topicSymbol,
      },
    });

    // Return the secret only at creation time (#481).
    res.status(201).json({
      id: sub.id,
      url: sub.url,
      secret,
      contractAddress: sub.contractAddress,
      eventType: sub.eventType,
      topicSymbol: sub.topicSymbol,
      active: sub.active,
      createdAt: sub.createdAt,
    });
  }),
);

/**
 * @swagger
 * /webhooks:
 *   get:
 *     summary: List webhook subscriptions owned by the caller
 *     security:
 *       - ApiKeyAuth: []
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: List of subscriptions (secrets omitted)
 *       401:
 *         description: API key required
 */
webhooksRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const subs = await prismaRead.webhookSubscription.findMany({
      where: { apiKeyId: req.apiKey!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        url: true,
        contractAddress: true,
        eventType: true,
        topicSymbol: true,
        active: true,
        createdAt: true,
      },
    });
    res.json({ data: subs });
  }),
);

/**
 * @swagger
 * /webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook subscription
 *     security:
 *       - ApiKeyAuth: []
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found or not owned by caller
 *       401:
 *         description: API key required
 */
webhooksRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await prisma.webhookSubscription.delete({
        where: { id: req.params.id, apiKeyId: req.apiKey!.id },
      });
      res.status(204).end();
    } catch {
      res.status(404).json({ error: 'Subscription not found' });
    }
  }),
);

/**
 * @swagger
 * /webhooks/{id}:
 *   patch:
 *     summary: Enable or disable a webhook subscription
 *     security:
 *       - ApiKeyAuth: []
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [active]
 *             properties:
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated subscription
 *       404:
 *         description: Not found or not owned by caller
 *       401:
 *         description: API key required
 */
webhooksRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const sub = await prisma.webhookSubscription.update({
        where: { id: req.params.id, apiKeyId: req.apiKey!.id },
        data: { active },
      });

      // When deactivating, immediately cancel all pending deliveries so the
      // retry loop doesn't attempt them before it notices the subscription is
      // inactive (#482).
      if (!active) {
        await prisma.webhookDelivery.updateMany({
          where: { subscriptionId: sub.id, status: 'pending' },
          data: {
            status: 'cancelled',
            processingStatus: 'done',
            leaseExpiresAt: null,
            nextRetryAt: null,
          },
        });
      }

      res.json({ id: sub.id, url: sub.url, active: sub.active, updatedAt: sub.updatedAt });
    } catch {
      res.status(404).json({ error: 'Subscription not found' });
    }
  }),
);

/**
 * @swagger
 * /webhooks/{id}/deliveries:
 *   get:
 *     summary: Get delivery history for a webhook subscription
 *     description: Returns the last 50 delivery attempts including status, HTTP response, and retry schedule.
 *     security:
 *       - ApiKeyAuth: []
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Delivery history
 *       404:
 *         description: Subscription not found or not owned by caller
 *       401:
 *         description: API key required
 */
webhooksRouter.get(
  '/:id/deliveries',
  asyncHandler(async (req: Request, res: Response) => {
    // Verify ownership before returning delivery history (#478).
    const sub = await prismaRead.webhookSubscription.findFirst({
      where: { id: req.params.id, apiKeyId: req.apiKey!.id },
      select: { id: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const deliveries = await prismaRead.webhookDelivery.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: deliveries });
  }),
);
