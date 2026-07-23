/**
 * Webhook Retention and Cleanup Service
 * Handles automatic deletion of expired webhook deliveries based on retention policies
 */

import { prismaWrite as prisma, prismaRead } from '../db';
import { logger } from '../logger';

/**
 * Cleanup expired webhook deliveries for WebhookDelivery
 */
export async function cleanupExpiredWebhookDeliveries(): Promise<void> {
  const now = new Date();

  try {
    const result = await prisma.webhookDelivery.deleteMany({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });

    if (result.count > 0) {
      logger.info('Cleaned up expired webhook deliveries', { count: result.count });
    }
  } catch (error) {
    logger.error('Error cleaning up webhook deliveries', { error });
    throw error;
  }
}

/**
 * Cleanup expired webhook deliveries for DevWebhookDelivery
 */
export async function cleanupExpiredDevWebhookDeliveries(): Promise<void> {
  const now = new Date();

  try {
    const result = await prisma.devWebhookDelivery.deleteMany({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });

    if (result.count > 0) {
      logger.info('Cleaned up expired dev webhook deliveries', { count: result.count });
    }
  } catch (error) {
    logger.error('Error cleaning up dev webhook deliveries', { error });
    throw error;
  }
}

/**
 * Cleanup all expired webhook deliveries
 * Call this periodically from a scheduled job (e.g., once per day)
 */
export async function cleanupAllExpiredWebhookDeliveries(): Promise<void> {
  await cleanupExpiredWebhookDeliveries();
  await cleanupExpiredDevWebhookDeliveries();
}

/**
 * Get cleanup stats for a specific subscription
 */
export async function getWebhookCleanupStats(subscriptionId: string): Promise<{
  totalDeliveries: number;
  expiredDeliveries: number;
  retentionDays: number;
  expiresAt: Date;
}> {
  const sub = await prismaRead.webhookSubscription.findUnique({
    where: { id: subscriptionId },
  });

  if (!sub) {
    throw new Error('Subscription not found');
  }

  const totalDeliveries = await prismaRead.webhookDelivery.count({
    where: { subscriptionId },
  });

  const now = new Date();
  const expiredDeliveries = await prismaRead.webhookDelivery.count({
    where: {
      subscriptionId,
      expiresAt: {
        lte: now,
      },
    },
  });

  const expiresAt = new Date(Date.now() + sub.responseRetentionDays * 24 * 60 * 60 * 1000);

  return {
    totalDeliveries,
    expiredDeliveries,
    retentionDays: sub.responseRetentionDays,
    expiresAt,
  };
}

/**
 * Force cleanup deliveries for a specific subscription before expiration
 * (for immediate deletion requests by users)
 */
export async function forceCleanupSubscriptionDeliveries(subscriptionId: string): Promise<number> {
  try {
    const result = await prisma.webhookDelivery.deleteMany({
      where: { subscriptionId },
    });

    logger.info('Force cleaned up webhook deliveries', { subscriptionId, count: result.count });
    return result.count;
  } catch (error) {
    logger.error('Error force cleaning webhook deliveries', { subscriptionId, error });
    throw error;
  }
}

/**
 * Force cleanup deliveries for a specific dev webhook before expiration
 */
export async function forceCleanupDevWebhookDeliveries(webhookId: string): Promise<number> {
  try {
    const result = await prisma.devWebhookDelivery.deleteMany({
      where: { webhookId },
    });

    logger.info('Force cleaned up dev webhook deliveries', { webhookId, count: result.count });
    return result.count;
  } catch (error) {
    logger.error('Error force cleaning dev webhook deliveries', { webhookId, error });
    throw error;
  }
}
