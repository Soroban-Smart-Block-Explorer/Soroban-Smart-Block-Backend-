import { prismaWrite as prisma } from '../db';
import { uuidv7 } from '../utils/uuidv7';

export interface SubscriptionConfig {
  userId?: string;
  channelName: string;
  filters?: any;
  deliveryType: 'webhook' | 'websocket' | 'sse' | 'queue';
  deliveryConfig: any;
  batchSize?: number;
  maxRatePerSecond?: number;
}

export interface SubscriptionFilters {
  pools?: string[];
  tokens?: string[];
  minAmount?: string;
  excludePools?: string[];
  contracts?: string[];
  accounts?: string[];
  eventTypes?: string[];
}

// Default page size cap for list queries — prevents unbounded scans (#724)
const LIST_PAGE_SIZE = 500;
// Maximum page size a caller may request (#724)
const MAX_PAGE_SIZE = 1000;

export class SubscriptionManager {
  async createSubscription(config: SubscriptionConfig) {
    const subscription = await prisma.feedSubscription.create({
      data: {
        id: uuidv7(),
        userId: config.userId,
        channelName: config.channelName,
        filters: config.filters,
        deliveryType: config.deliveryType,
        deliveryConfig: config.deliveryConfig,
        batchSize: config.batchSize || 1,
        maxRatePerSecond: config.maxRatePerSecond,
        status: 'active',
      },
    });

    return subscription;
  }

  async getSubscription(id: string) {
    return await prisma.feedSubscription.findUnique({
      where: { id },
    });
  }

  /**
   * List subscriptions with cursor-based pagination to avoid full-table scans (#724).
   * Returns at most `limit` rows (capped at MAX_PAGE_SIZE).
   */
  async listSubscriptions(userId?: string, limit = LIST_PAGE_SIZE, cursor?: string) {
    const take = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
    return await prisma.feedSubscription.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }

  async updateSubscription(id: string, updates: Partial<SubscriptionConfig & { status: string }>) {
    const subscription = await prisma.feedSubscription.update({
      where: { id },
      data: {
        ...updates,
        filters: updates.filters,
        deliveryConfig: updates.deliveryConfig,
      },
    });

    return subscription;
  }

  async deleteSubscription(id: string) {
    await prisma.feedSubscription.delete({
      where: { id },
    });
  }

  async pauseSubscription(id: string) {
    return await this.updateSubscription(id, { status: 'paused' });
  }

  async resumeSubscription(id: string) {
    return await this.updateSubscription(id, { status: 'active' });
  }

  /**
   * Return all active subscriptions for a channel using cursor-based pagination
   * so that channels with many subscribers don't cause unbounded queries (#724).
   */
  async getActiveSubscriptions(channelName: string) {
    const results: Awaited<ReturnType<typeof prisma.feedSubscription.findMany>> = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const page = await prisma.feedSubscription.findMany({
        where: {
          channelName,
          status: 'active',
        },
        take: LIST_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });

      results.push(...page);

      if (page.length < LIST_PAGE_SIZE) {
        hasMore = false;
      } else {
        cursor = page[page.length - 1].id;
      }
    }

    return results;
  }

  async updateDeliveryStats(subscriptionId: string, delivered: boolean, error?: string) {
    const updates: any = {
      lastDeliveryAt: new Date(),
    };

    if (delivered) {
      updates.totalDelivered = { increment: 1 };
      updates.lastError = null;
    } else {
      updates.totalFailed = { increment: 1 };
      if (error) {
        updates.lastError = error;
      }
    }

    await prisma.feedSubscription.update({
      where: { id: subscriptionId },
      data: updates,
    });
  }

  matchesFilters(data: any, filters: SubscriptionFilters): boolean {
    if (!filters) return true;

    // Pool filtering for trade data
    if (filters.pools && data.poolAddress) {
      if (!filters.pools.includes(data.poolAddress)) {
        return false;
      }
    }

    // Exclude pools
    if (filters.excludePools && data.poolAddress) {
      if (filters.excludePools.includes(data.poolAddress)) {
        return false;
      }
    }

    // Token filtering
    if (filters.tokens && (data.tokenIn || data.tokenOut)) {
      const hasMatchingToken = filters.tokens.some(
        (token) => token === data.tokenIn || token === data.tokenOut,
      );
      if (!hasMatchingToken) {
        return false;
      }
    }

    // Minimum amount filtering
    if (filters.minAmount && data.amountIn) {
      const amount = parseFloat(data.amountIn);
      const minAmount = parseFloat(filters.minAmount);
      if (amount < minAmount) {
        return false;
      }
    }

    // Contract filtering
    if (filters.contracts && data.contractAddress) {
      if (!filters.contracts.includes(data.contractAddress)) {
        return false;
      }
    }

    // Account filtering
    if (filters.accounts && (data.sourceAccount || data.sender)) {
      const account = data.sourceAccount || data.sender;
      if (!filters.accounts.includes(account)) {
        return false;
      }
    }

    // Event type filtering
    if (filters.eventTypes && data.eventType) {
      if (!filters.eventTypes.includes(data.eventType)) {
        return false;
      }
    }

    return true;
  }
}
