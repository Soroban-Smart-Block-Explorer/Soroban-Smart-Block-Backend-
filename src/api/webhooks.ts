import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma, prismaRead } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

export const webhooksRouter = Router();

const createSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(8).optional(),
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
 *       provided secret (X-Webhook-Signature header). Failed deliveries are
 *       retried with exponential backoff (up to 5 attempts).
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
 *                 minLength: 8
 *                 description: Signing secret for HMAC-SHA256 signature verification
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
 *         description: Subscription created
 *       400:
 *         description: Validation error
 */
// POST /webhooks — register a new subscription
webhooksRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const sub = await prisma.webhookSubscription.create({ data: parsed.data });
    res.status(201).json(sub);
  }),
);

/**
 * @swagger
 * /webhooks:
 *   get:
 *     summary: List webhook subscriptions
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: List of subscriptions (secrets omitted)
 */
// GET /webhooks — list all subscriptions
webhooksRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const subs = await prismaRead.webhookSubscription.findMany({
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
 *         description: Not found
 */
// DELETE /webhooks/:id — remove a subscription
webhooksRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.webhookSubscription.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

/**
 * @swagger
 * /webhooks/{id}:
 *   patch:
 *     summary: Enable or disable a webhook subscription
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
 *         description: Not found
 */
// PATCH /webhooks/:id — enable / disable
webhooksRouter.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    try {
      const sub = await prisma.webhookSubscription.update({
        where: { id: req.params.id },
        data: { active },
      });
      res.json(sub);
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
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Delivery history
 */
// GET /webhooks/:id/deliveries — delivery history for a subscription
webhooksRouter.get(
  '/:id/deliveries',
  asyncHandler(async (req: Request, res: Response) => {
    const deliveries = await prismaRead.webhookDelivery.findMany({
      where: { subscriptionId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: deliveries });
  }),
);
