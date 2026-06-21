import { EventEmitter } from 'events';
import { ChannelManager } from './channelManager';
import { feedPublisher } from './publisher';
import { deliveryService } from './deliveryService';
import { SubscriptionManager } from './subscriptionManager';
import { FeedWebSocketServer } from './websocketServer';

export class FeedOrchestrator extends EventEmitter {
  private subscriptionManager = new SubscriptionManager();
  private wsServer?: FeedWebSocketServer;
  private metricsInterval!: NodeJS.Timeout;

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

    console.log('Feed orchestrator initialized');
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
          console.error(`Delivery failed for subscription ${subscription.id}:`, error);
        });
      }

      // Broadcast to WebSocket connections
      if (this.wsServer) {
        this.wsServer.broadcast(message.channelName, message);
      }

      // Emit for SSE and other real-time handlers
      this.emit('message', message);
    } catch (error) {
      console.error('Failed to distribute message:', error);
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
    // In real implementation, this would lookup token metadata
    const tokenMap: Record<string, string> = {
      native: 'XLM',
      'CAQME...': 'USDC',
    };
    return tokenMap[address] || 'UNKNOWN';
  }

  private startMetricsCollection() {
    this.metricsInterval = setInterval(async () => {
      try {
        // Collect and publish system metrics
        await this.collectSystemMetrics();
      } catch (error) {
        console.error('Failed to collect metrics:', error);
      }
    }, 60000); // Every minute
  }

  private async collectSystemMetrics() {
    const now = new Date();

    // Connection metrics
    const connectionCount = this.wsServer?.getConnectionCount() || 0;
    await this.publishMetric('websocket_connections', connectionCount, '1m');

    // Active subscriptions
    const activeSubscriptions = await this.subscriptionManager.listSubscriptions();
    const activeCount = activeSubscriptions.filter((sub) => sub.status === 'active').length;
    await this.publishMetric('active_subscriptions', activeCount, '1m');

    // Channel activity
    const channels = this.wsServer?.getActiveChannels() || [];
    await this.publishMetric('active_channels', channels.length, '1m');

    // Mock additional metrics (in real implementation, these would come from actual data)
    await this.publishMetric('gas_price_avg', Math.random() * 200 + 100, '1m');
    await this.publishMetric('transactions_per_second', Math.random() * 50 + 10, '1m');
    await this.publishMetric('active_accounts_24h', Math.floor(Math.random() * 10000) + 5000, '1m');
  }

  getStats() {
    return {
      connections: this.wsServer?.getConnectionCount() || 0,
      activeChannels: this.wsServer?.getActiveChannels() || [],
      uptime: process.uptime(),
    };
  }

  async shutdown() {
    console.log('Shutting down feed orchestrator...');

    clearInterval(this.metricsInterval);

    if (this.wsServer) {
      this.wsServer.shutdown();
    }

    await deliveryService.shutdown();

    this.removeAllListeners();

    console.log('Feed orchestrator shutdown complete');
  }
}

export const feedOrchestrator = new FeedOrchestrator();
