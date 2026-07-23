import { Router } from 'express';
import { z } from 'zod';
import { ChannelManager } from '../feed/channelManager';
import { SubscriptionManager } from '../feed/subscriptionManager';
import { prismaRead as prisma } from '../db';

const router = Router();

// Validation schemas
const subscribeSchema = z.object({
  channelName: z.string(),
  filters: z.any().optional(),
  deliveryType: z.enum(['webhook', 'websocket', 'sse', 'queue']),
  deliveryConfig: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    batchSize: z.number().min(1).max(1000).optional(),
    maxInterval: z.number().optional(),
    retryOnFailure: z.boolean().optional(),
    maxRetries: z.number().optional(),
  }),
});

const subscriptionManager = new SubscriptionManager();

// GET /api/v1/feed/channels - List available channels
router.get('/channels', async (req, res) => {
  try {
    const channels = await prisma.feedChannel.findMany({
      where: { enabled: true },
      select: {
        name: true,
        description: true,
        category: true,
        schema: true,
        retentionDays: true,
      },
    });

    res.json({
      channels: channels.map((channel) => ({
        ...channel,
        latencyTarget: getLatencyTarget(channel.name),
      })),
    });
  } catch (error) {
    console.error('Failed to fetch channels:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/feed/subscribe - Subscribe to feed
router.post('/subscribe', async (req, res) => {
  try {
    const validatedData = subscribeSchema.parse(req.body);

    // Validate channel exists
    if (!ChannelManager.isValidChannel(validatedData.channelName)) {
      return res.status(400).json({ error: 'Invalid channel name' });
    }

    const subscription = await subscriptionManager.createSubscription({
      ...validatedData,
      userId: req.headers['x-user-id'] as string, // In real implementation, extract from auth
    });

    res.status(201).json({
      id: subscription.id,
      channelName: subscription.channelName,
      deliveryType: subscription.deliveryType,
      status: subscription.status,
      createdAt: subscription.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Failed to create subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/subscriptions - List user's subscriptions
router.get('/subscriptions', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const subscriptions = await subscriptionManager.listSubscriptions(userId);

    res.json({
      subscriptions: subscriptions.map((sub: any) => ({
        id: sub.id,
        channelName: sub.channelName,
        deliveryType: sub.deliveryType,
        status: sub.status,
        totalDelivered: sub.totalDelivered,
        totalFailed: sub.totalFailed,
        lastDeliveryAt: sub.lastDeliveryAt,
        createdAt: sub.createdAt,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch subscriptions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/subscriptions/:id - Get subscription details
router.get('/subscriptions/:id', async (req, res) => {
  try {
    const subscription = await subscriptionManager.getSubscription(req.params.id);

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json(subscription);
  } catch (error) {
    console.error('Failed to fetch subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v1/feed/subscriptions/:id - Update subscription
router.put('/subscriptions/:id', async (req, res) => {
  try {
    const updates = req.body;
    const subscription = await subscriptionManager.updateSubscription(req.params.id, updates);

    res.json(subscription);
  } catch (error) {
    console.error('Failed to update subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/v1/feed/subscriptions/:id - Unsubscribe
router.delete('/subscriptions/:id', async (req, res) => {
  try {
    await subscriptionManager.deleteSubscription(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/subscriptions/:id/status - Get delivery stats
router.get('/subscriptions/:id/status', async (req, res) => {
  try {
    const subscription = await subscriptionManager.getSubscription(req.params.id);

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Calculate delivery rate and average latency
    const deliveryRate =
      subscription.totalDelivered + subscription.totalFailed > 0
        ? (subscription.totalDelivered / (subscription.totalDelivered + subscription.totalFailed)) *
          100
        : 0;

    res.json({
      id: subscription.id,
      status: subscription.status,
      totalDelivered: subscription.totalDelivered,
      totalFailed: subscription.totalFailed,
      deliveryRate: Math.round(deliveryRate * 100) / 100,
      lastDeliveryAt: subscription.lastDeliveryAt,
      lastError: subscription.lastError,
    });
  } catch (error) {
    console.error('Failed to fetch subscription status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/feed/subscriptions/:id/pause - Pause delivery
router.post('/subscriptions/:id/pause', async (req, res) => {
  try {
    const subscription = await subscriptionManager.pauseSubscription(req.params.id);
    res.json({ status: subscription.status });
  } catch (error) {
    console.error('Failed to pause subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/feed/subscriptions/:id/resume - Resume delivery
router.post('/subscriptions/:id/resume', async (req, res) => {
  try {
    const subscription = await subscriptionManager.resumeSubscription(req.params.id);
    res.json({ status: subscription.status });
  } catch (error) {
    console.error('Failed to resume subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/feed/subscriptions/:id/test - Send test payload
router.post('/subscriptions/:id/test', async (req, res) => {
  try {
    const subscription = await subscriptionManager.getSubscription(req.params.id);

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Create test message based on channel type
    const testMessage = generateTestMessage(subscription.channelName);

    // TODO: Deliver test message

    res.json({ message: 'Test payload sent', data: testMessage });
  } catch (error) {
    console.error('Failed to send test payload:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function getLatencyTarget(channelName: string): string {
  const targets: Record<string, string> = {
    transactions: '<500ms',
    events: '<200ms',
    ledgers: '<100ms',
    trades: '<500ms',
    liquidations: '<200ms',
    metrics: '<1s',
    contracts: '<1s',
    accounts: '<500ms',
    oracle: '<200ms',
    governance: '<1s',
  };
  return targets[channelName] || '<1s';
}

function generateTestMessage(channelName: string) {
  const testMessages: Record<string, any> = {
    transactions: {
      type: 'transaction',
      schemaVersion: 1,
      hash: 'abc123...',
      ledgerSequence: 12345,
      timestamp: new Date().toISOString(),
      sourceAccount: 'GTEST...',
      fee: '100',
      operations: [],
      status: 'success',
    },
    trades: {
      type: 'trade',
      schemaVersion: 1,
      txHash: 'abc123...',
      poolAddress: 'CTEST...',
      tokenIn: { address: 'CTOKEN1...', symbol: 'XLM' },
      tokenOut: { address: 'CTOKEN2...', symbol: 'USDC' },
      amountIn: '1000000000',
      amountOut: '950000000',
      price: '0.95',
      timestamp: new Date().toISOString(),
    },
  };

  return (
    testMessages[channelName] || { message: 'Test message', timestamp: new Date().toISOString() }
  );
}

export default router;
