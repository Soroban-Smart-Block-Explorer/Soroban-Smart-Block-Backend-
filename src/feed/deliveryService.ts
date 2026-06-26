import axios from 'axios';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { SubscriptionManager } from './subscriptionManager';

export interface DeliveryConfig {
  webhook?: {
    url: string;
    headers?: Record<string, string>;
    secret?: string;
    retryOnFailure?: boolean;
    maxRetries?: number;
  };
  websocket?: {
    connectionId: string;
  };
  sse?: {
    connectionId: string;
  };
}

export class DeliveryService extends EventEmitter {
  private subscriptionManager = new SubscriptionManager();
  private deliveryQueues = new Map<string, any[]>();
  private batchTimers = new Map<string, NodeJS.Timeout>();

  async deliverMessage(subscriptionId: string, message: any) {
    try {
      const subscription = await this.subscriptionManager.getSubscription(subscriptionId);
      if (!subscription || subscription.status !== 'active') {
        return;
      }

      // Apply filters
      if (subscription.filters) {
        const matches = this.subscriptionManager.matchesFilters(
          message.data,
          subscription.filters as any,
        );
        if (!matches) {
          return;
        }
      }

      // Handle batching
      if ((subscription.batchSize ?? 0) > 1) {
        await this.addToBatch(subscription, message);
        return;
      }

      // Direct delivery for single messages
      await this.deliverSingle(subscription, [message]);
    } catch (error) {
      console.error('Delivery failed:', error);
      await this.subscriptionManager.updateDeliveryStats(
        subscriptionId,
        false,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  private async addToBatch(subscription: any, message: any) {
    if (!this.deliveryQueues.has(subscription.id)) {
      this.deliveryQueues.set(subscription.id, []);
    }

    const queue = this.deliveryQueues.get(subscription.id)!;
    queue.push(message);

    // Clear existing timer
    const existingTimer = this.batchTimers.get(subscription.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Deliver immediately if batch is full
    if (queue.length >= subscription.batchSize) {
      await this.deliverBatch(subscription);
      return;
    }

    // Set timer for partial batch delivery (max 5 seconds)
    const timer = setTimeout(async () => {
      await this.deliverBatch(subscription);
    }, 5000);

    this.batchTimers.set(subscription.id, timer);
  }

  private async deliverBatch(subscription: any) {
    const queue = this.deliveryQueues.get(subscription.id);
    if (!queue || queue.length === 0) {
      return;
    }

    const messages = queue.splice(0, subscription.batchSize);

    // Clear timer
    const timer = this.batchTimers.get(subscription.id);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(subscription.id);
    }

    await this.deliverSingle(subscription, messages);
  }

  private async deliverSingle(subscription: any, messages: any[]) {
    const config = subscription.deliveryConfig;

    switch (subscription.deliveryType) {
      case 'webhook':
        await this.deliverWebhook(subscription.id, config, messages);
        break;
      case 'websocket':
        await this.deliverWebSocket(subscription.id, config, messages);
        break;
      case 'sse':
        await this.deliverSSE(subscription.id, config, messages);
        break;
      case 'queue':
        await this.deliverQueue(subscription.id, config, messages);
        break;
    }
  }

  private async deliverWebhook(subscriptionId: string, config: any, messages: any[]) {
    try {
      const payload = {
        subscriptionId,
        messages: messages.map((msg) => ({
          sequence: msg.sequence.toString(),
          channel: msg.channelName,
          data: msg.data,
          timestamp: msg.timestamp,
        })),
      };

      const headers: any = {
        'Content-Type': 'application/json',
        'User-Agent': 'Soroban-Feed/1.0',
        ...config.headers,
      };

      // Add HMAC signature if secret is provided
      if (config.secret) {
        const signature = this.generateHMACSignature(JSON.stringify(payload), config.secret);
        headers['X-Soroban-Signature'] = signature;
      }

      const response = await axios.post(config.url, payload, {
        headers,
        timeout: 10000,
      });

      if (response.status >= 200 && response.status < 300) {
        await this.subscriptionManager.updateDeliveryStats(subscriptionId, true);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error(
        `Webhook delivery failed for ${subscriptionId}:`,
        error instanceof Error ? error.message : 'Unknown error',
      );
      await this.subscriptionManager.updateDeliveryStats(
        subscriptionId,
        false,
        error instanceof Error ? error.message : 'Unknown error',
      );

      // Retry logic can be added here
      if (config.retryOnFailure && config.maxRetries > 0) {
        // Implement exponential backoff retry
      }
    }
  }

  private async deliverWebSocket(subscriptionId: string, config: any, messages: any[]) {
    // Emit to WebSocket connection manager
    this.emit('websocket-delivery', {
      connectionId: config.connectionId,
      subscriptionId,
      messages,
    });
  }

  private async deliverSSE(subscriptionId: string, config: any, messages: any[]) {
    // Emit to SSE connection manager
    this.emit('sse-delivery', {
      connectionId: config.connectionId,
      subscriptionId,
      messages,
    });
  }

  private async deliverQueue(subscriptionId: string, config: any, messages: any[]) {
    // Emit to message queue system (Redis/RabbitMQ)
    this.emit('queue-delivery', {
      queue: config.queue,
      subscriptionId,
      messages,
    });
  }

  private generateHMACSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return 'sha256=' + hmac.digest('hex');
  }

  async shutdown() {
    // Clear all batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    this.deliveryQueues.clear();
  }
}

export const deliveryService = new DeliveryService();
