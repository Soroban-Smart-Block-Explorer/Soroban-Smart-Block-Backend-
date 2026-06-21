import { prisma } from '../db';

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

export class SubscriptionManager {
  async createSubscription(config: SubscriptionConfig) {
    const subscription = await prisma.feedSubscription.create({
      data: {
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

  async listSubscriptions(userId?: string) {
    return await prisma.feedSubscription.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
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

  async getActiveSubscriptions(channelName: string) {
    return await prisma.feedSubscription.findMany({
      where: {
        channelName,
        status: 'active',
      },
    });
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
