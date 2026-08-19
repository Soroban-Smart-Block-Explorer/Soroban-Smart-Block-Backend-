import axios from 'axios';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { SubscriptionManager } from './subscriptionManager';
import { logger } from '../logger';

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

// Configurable batching interval for endpoint-grouped deliveries (ms) (#726)
const ENDPOINT_BATCH_INTERVAL_MS = parseInt(
  process.env.FEED_ENDPOINT_BATCH_INTERVAL_MS ?? '200',
  10,
);

// Maximum number of messages to hold per endpoint before flushing early (#726)
const ENDPOINT_BATCH_MAX_SIZE = parseInt(process.env.FEED_ENDPOINT_BATCH_MAX_SIZE ?? '50', 10);

/** Pending work grouped by endpoint URL for batched delivery (#726). */
interface EndpointBatchEntry {
  subscriptionId: string;
  config: any;
  message: any;
}

export class DeliveryService extends EventEmitter {
  private subscriptionManager = new SubscriptionManager();
  private deliveryQueues = new Map<string, any[]>();
  private batchTimers = new Map<string, NodeJS.Timeout>();

  // Endpoint-level batching maps: keyed by endpoint URL (#726)
  private endpointQueues = new Map<string, EndpointBatchEntry[]>();
  private endpointTimers = new Map<string, NodeJS.Timeout>();

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
      logger.error('Delivery failed:', error);
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
        // Route through endpoint batcher to group by URL (#726)
        for (const message of messages) {
          await this.enqueueEndpointBatch(subscription.id, config, message);
        }
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

  /**
   * Enqueue a webhook message into the per-endpoint batch.
   * Messages sharing the same URL are held for up to ENDPOINT_BATCH_INTERVAL_MS
   * before being flushed as a single HTTP request (#726).
   */
  private async enqueueEndpointBatch(subscriptionId: string, config: any, message: any) {
    const endpointUrl: string = config.url;
    if (!endpointUrl) {
      // Fallback: deliver immediately if no URL configured
      await this.deliverWebhook(subscriptionId, config, [message]);
      return;
    }

    if (!this.endpointQueues.has(endpointUrl)) {
      this.endpointQueues.set(endpointUrl, []);
    }

    const queue = this.endpointQueues.get(endpointUrl)!;
    queue.push({ subscriptionId, config, message });

    // Flush immediately when the per-endpoint batch reaches max size
    if (queue.length >= ENDPOINT_BATCH_MAX_SIZE) {
      await this.flushEndpointBatch(endpointUrl);
      return;
    }

    // Schedule a flush if one isn't already pending
    if (!this.endpointTimers.has(endpointUrl)) {
      const timer = setTimeout(async () => {
        await this.flushEndpointBatch(endpointUrl);
      }, ENDPOINT_BATCH_INTERVAL_MS);
      this.endpointTimers.set(endpointUrl, timer);
    }
  }

  /**
   * Flush all queued messages for a given endpoint URL.
   * Entries from different subscriptions that share the same URL are sent in
   * a single HTTP request — one POST per unique endpoint (#726).
   */
  private async flushEndpointBatch(endpointUrl: string) {
    // Cancel the pending timer (if any)
    const timer = this.endpointTimers.get(endpointUrl);
    if (timer) {
      clearTimeout(timer);
      this.endpointTimers.delete(endpointUrl);
    }

    const queue = this.endpointQueues.get(endpointUrl);
    if (!queue || queue.length === 0) return;

    // Drain the queue
    const entries = queue.splice(0, queue.length);
    if (entries.length === 0) return;

    // Use the config from the first entry (all share the same endpoint URL)
    const { config } = entries[0];

    // Collect all messages — include subscriptionId per message for traceability
    const messages = entries.map((e) => ({ ...e.message, subscriptionId: e.subscriptionId }));

    // Deliver as a single batched request; update stats for each subscription
    const uniqueSubIds = [...new Set(entries.map((e) => e.subscriptionId))];
    try {
      await this.deliverWebhook(uniqueSubIds[0], config, messages);
      for (const subId of uniqueSubIds) {
        await this.subscriptionManager.updateDeliveryStats(subId, true);
      }
    } catch (error) {
      for (const subId of uniqueSubIds) {
        await this.subscriptionManager.updateDeliveryStats(
          subId,
          false,
          error instanceof Error ? error.message : 'Unknown error',
        );
      }
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
      logger.error(
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
    // Clear all per-subscription batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    this.deliveryQueues.clear();

    // Flush and clear endpoint-level batch timers (#726)
    for (const timer of this.endpointTimers.values()) {
      clearTimeout(timer);
    }
    this.endpointTimers.clear();
    this.endpointQueues.clear();
  }
}

export const deliveryService = new DeliveryService();
