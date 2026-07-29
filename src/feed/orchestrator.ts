import { EventEmitter } from 'events';
import { ChannelManager } from './channelManager';
import { feedPublisher } from './publisher';
import { deliveryService } from './deliveryService';
import { SubscriptionManager } from './subscriptionManager';
import { FeedWebSocketServer } from './websocketServer';
import { streamingServer } from './streamingServer';
import { getTokenMetadata } from '../indexer/token-metadata';
import { scheduler } from '../scheduler/cron-scheduler';
import type { Logger } from '../services/container';
import { container } from '../services/container';

export class FeedOrchestrator extends EventEmitter {
  private subscriptionManager = new SubscriptionManager();
  private wsServer?: FeedWebSocketServer;
  private metricsJobId = 'feed-orchestrator-metrics';
  private logger: Logger;

  /**
   * Create a FeedOrchestrator with optional dependency injection.
   * @param loggerDep Logger instance (defaults to container's logger)
   */
  constructor(loggerDep?: Logger) {
    super();
    this.logger = loggerDep || container.getLogger();
  }

  async initialize(httpServer?: any) {
    // Initialize default channels
    await ChannelManager.initializeDefaultChannels();

    // Initialize sequence counter
    await feedPublisher.initializeSequence();

    // Setup WebSocket server if HTTP server provided
    if (httpServer) {
      this.wsServer = new FeedWebSocketServer(httpServer);
    }

    // Listen for feed messages and distribute to subscribers
    feedPublisher.on('message', async (message) => {
      await this.distributeMessage(message);
    });

    // Start metrics collection
    this.startMetricsCollection();

    this.logger.info('Feed orchestrator initialized');
  }

  private async distributeMessage(message: any) {
    try {
      // Get active subscriptions for this channel
      const subscriptions = await this.subscriptionManager.getActiveSubscriptions(
        message.channelName,
      );

      // Deliver to each subscription
      for (const subscription of subscriptions) {
        deliveryService.deliverMessage(subscription.id, message).catch((error) => {
          this.logger.error(`Delivery failed for subscription ${subscription.id}:`, error);
        });
      }

      // Broadcast to all real-time streaming connections (WebSocket + SSE)
      streamingServer.broadcast(message.channelName, message);
    } catch (error) {
      this.logger.error('Failed to distribute message:', error);
    }
  }

  async publishTransaction(transaction: any) {
    await feedPublisher.publish({
      channelName: 'transactions',
      data: {
        type: 'transaction',
        schemaVersion: 1,
        hash: transaction.hash,
        ledgerSequence: transaction.ledgerSequence,
        timestamp: transaction.ledgerCloseTime,
        sourceAccount: transaction.sourceAccount,
        operations: transaction.operations || [],
        status: transaction.status,
        fee: transaction.feeCharged,
        footprint: transaction.sorobanResources,
      },
      ledgerSequence: transaction.ledgerSequence,
      timestamp: new Date(transaction.ledgerCloseTime),
    });
  }

  async publishEvent(event: any) {
    await feedPublisher.publish({
      channelName: 'events',
      data: {
        type: 'event',
        schemaVersion: 1,
        id: event.id,
        transactionHash: event.transactionHash,
        contractAddress: event.contractAddress,
        eventType: event.eventType,
        topicSymbol: event.topicSymbol,
        decoded: event.decoded,
        ledgerSequence: event.ledgerSequence,
        timestamp: event.ledgerCloseTime,
      },
      ledgerSequence: event.ledgerSequence,
      timestamp: new Date(event.ledgerCloseTime),
    });
  }

  async publishLedger(ledger: any) {
    await feedPublisher.publish({
      channelName: 'ledgers',
      data: {
        type: 'ledger',
        schemaVersion: 1,
        sequence: ledger.sequence,
        hash: ledger.hash,
        closeTime: ledger.closeTime,
        txCount: ledger.txCount,
        timestamp: ledger.closeTime,
      },
      ledgerSequence: ledger.sequence,
      timestamp: new Date(ledger.closeTime),
    });
  }

  async publishTrade(trade: any) {
    await feedPublisher.publish({
      channelName: 'trades',
      data: {
        type: 'trade',
        schemaVersion: 1,
        txHash: trade.txHash,
        poolAddress: trade.poolAddress,
        poolType: 'constant_product',
        tokenIn: {
          address: trade.tokenIn,
          symbol: await this.getTokenSymbol(trade.tokenIn),
          decimals: 7,
        },
        tokenOut: {
          address: trade.tokenOut,
          symbol: await this.getTokenSymbol(trade.tokenOut),
          decimals: 7,
        },
        amountIn: trade.amountIn.toString(),
        amountOut: trade.amountOut.toString(),
        price: trade.price.toString(),
        priceUsd: trade.priceUsd,
        sender: trade.sender,
        fee: trade.fee?.toString(),
        feeUsd: trade.feeUsd,
        ledgerSequence: trade.ledgerSequence,
        timestamp: trade.timestamp,
      },
      ledgerSequence: trade.ledgerSequence,
      timestamp: new Date(trade.timestamp),
    });
  }

  async publishMetric(name: string, value: number, granularity = '1m', metadata?: any) {
    await feedPublisher.publish({
      channelName: 'metrics',
      data: {
        type: 'metric',
        schemaVersion: 1,
        name,
        value,
        granularity,
        metadata,
        timestamp: new Date().toISOString(),
      },
      ledgerSequence: 0, // Metrics don't have ledger sequence
      timestamp: new Date(),
    });
  }

  private async getTokenSymbol(address: string): Promise<string> {
    const meta = await getTokenMetadata(address);
    return meta?.symbol ?? 'UNKNOWN';
  }

  private startMetricsCollection() {
    // Register metrics collection with node-cron scheduler
    // Runs every minute (0 * * * *) with backpressure handling
    try {
      scheduler.register({
        id: this.metricsJobId,
        taskName: 'Feed Orchestrator Metrics Collection',
        cronExpression: '* * * * *', // Every minute
        execute: async () => this.collectSystemMetrics(),
        maxDuration: 10_000, // 10s timeout
        retryOnFailure: true,
        retryDelayMs: 5000,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        // Job already registered, skip
        this.logger.debug('[orchestrator] Metrics job already registered');
      } else {
        throw error;
      }
    }
  }

  private async collectSystemMetrics() {
    try {
      // Connection metrics
      const connectionCount = streamingServer.getConnectionCount();
      await this.publishMetric('streaming_connections', connectionCount, '1m');

      // Active subscriptions
      const activeSubscriptions = await this.subscriptionManager.listSubscriptions();
      const activeCount = activeSubscriptions.filter((sub) => sub.status === 'active').length;
      await this.publishMetric('active_subscriptions', activeCount, '1m');

      // Channel activity
      const channels = streamingServer.getActiveChannels();
      await this.publishMetric('active_channels', channels.length, '1m');

      // Mock additional metrics (in real implementation, these would come from actual data)
      await this.publishMetric('gas_price_avg', Math.random() * 200 + 100, '1m');
      await this.publishMetric('transactions_per_second', Math.random() * 50 + 10, '1m');
      await this.publishMetric(
        'active_accounts_24h',
        Math.floor(Math.random() * 10000) + 5000,
        '1m',
      );
    } catch (error) {
      this.logger.error('Failed to collect metrics:', error);
      throw error; // Re-throw so scheduler can handle retry/logging
    }
  }

  getStats() {
    return {
      connections: streamingServer.getConnectionCount(),
      activeChannels: streamingServer.getActiveChannels(),
      uptime: process.uptime(),
    };
  }

  async shutdown() {
    this.logger.info('Shutting down feed orchestrator...');

    // Stop the metrics job via scheduler
    try {
      scheduler.stop(this.metricsJobId);
    } catch (error) {
      this.logger.debug('[orchestrator] Metrics job was not running');
    }

    streamingServer.shutdown();

    if (this.wsServer) {
      this.wsServer.shutdown();
    }

    await deliveryService.shutdown();

    this.removeAllListeners();

    this.logger.info('Feed orchestrator shutdown complete');
  }
}

export const feedOrchestrator = new FeedOrchestrator();
