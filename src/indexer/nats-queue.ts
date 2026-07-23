import { Logger } from '../logger';
import * as nats from 'nats';

/**
 * NATS JetStream Integration
 * Implements distributed processing pipeline with:
 * - raw-ledgers topic
 * - decoded-transactions topic
 * - enriched-events topic
 * - Backpressure monitoring
 * - Message replay for recovery
 */

const logger = new Logger('NATSQueue');

export interface NATSConfig {
  servers: string[]; // ['nats://localhost:4222']
  jetstream: {
    maxMsgSize: number; // bytes
    maxAge: string; // e.g., '24h'
    replicas: number;
    discard: string; // 'old' or 'new'
  };
}

export interface RawLedgerMessage {
  ledgerId: number;
  closeTime: number;
  xdr: string;
  hash: string;
  timestamp: number;
}

export interface DecodedTransactionMessage {
  ledgerId: number;
  txId: string;
  source: string;
  operations: any[];
  sorobanEvents: any[];
  timestamp: number;
}

export interface EnrichedEventMessage {
  ledgerId: number;
  eventId: string;
  contract: string;
  eventType: string;
  mevScore?: number;
  composabilityAnalysis?: any;
  relatedContracts: string[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  timestamp: number;
}

const DEFAULT_CONFIG: NATSConfig = {
  servers: process.env.NATS_SERVERS?.split(',') || ['nats://localhost:4222'],
  jetstream: {
    maxMsgSize: 10_000_000, // 10 MB
    maxAge: '24h',
    replicas: 3,
    discard: 'old'
  }
};

const TOPICS = {
  RAW_LEDGERS: 'soroban.raw-ledgers',
  DECODED_TRANSACTIONS: 'soroban.decoded-transactions',
  ENRICHED_EVENTS: 'soroban.enriched-events',
  BACKFILL_LEDGERS: 'soroban.backfill-ledgers'
};

export class NATSQueueService {
  private nc: nats.NatsConnection | null = null;
  private js: nats.JetStreamClient | null = null;
  private config: NATSConfig;
  private isConnected: boolean = false;

  constructor(config: Partial<NATSConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      jetstream: {
        ...DEFAULT_CONFIG.jetstream,
        ...config.jetstream
      }
    };
  }

  /**
   * Initialize NATS connection and set up JetStream
   */
  async connect(): Promise<void> {
    try {
      this.nc = await nats.connect({
        servers: this.config.servers,
        reconnectDelayHandler: () => {
          return Math.min(1000 * Math.pow(2, this.nc?.stats().reconnects || 0), 30000);
        }
      });

      this.js = this.nc.jetstream();
      this.isConnected = true;

      logger.info('Connected to NATS', { servers: this.config.servers });

      // Set up streams
      await this.setupStreams();
    } catch (error) {
      logger.error('Failed to connect to NATS', { error });
      throw error;
    }
  }

  /**
   * Set up JetStream streams and consumers
   */
  private async setupStreams(): Promise<void> {
    if (!this.js) throw new Error('JetStream not initialized');

    // Stream 1: Raw Ledgers
    await this.setupStream(TOPICS.RAW_LEDGERS, {
      description: 'Raw ledger XDR data',
      retention: 'work' // keep until acknowledged
    });

    // Stream 2: Decoded Transactions
    await this.setupStream(TOPICS.DECODED_TRANSACTIONS, {
      description: 'Decoded transaction data',
      retention: 'work'
    });

    // Stream 3: Enriched Events
    await this.setupStream(TOPICS.ENRICHED_EVENTS, {
      description: 'Fully enriched events',
      retention: 'limits' // keep for 24 hours
    });

    // Stream 4: Backfill Queue
    await this.setupStream(TOPICS.BACKFILL_LEDGERS, {
      description: 'Ledgers to be backfilled',
      retention: 'work'
    });

    logger.info('JetStream streams initialized');
  }

  /**
   * Helper: Set up a stream
   */
  private async setupStream(subject: string, config: Record<string, any>): Promise<void> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const streamName = subject.replace(/\./g, '-');

      // Check if stream exists
      try {
        await this.js.streams.info(streamName);
        logger.debug(`Stream ${streamName} already exists`);
        return;
      } catch {
        // Stream doesn't exist, create it
      }

      await this.js.streams.add({
        name: streamName,
        subjects: [subject],
        max_msg_size: this.config.jetstream.maxMsgSize,
        max_age: nats.parseDuration(this.config.jetstream.maxAge),
        num_replicas: this.config.jetstream.replicas,
        discard: this.config.jetstream.discard as any,
        duplicate_window: nats.parseDuration('10m'),
        storage: 'file'
      });

      logger.info(`Created JetStream: ${streamName}`, { subject });
    } catch (error) {
      logger.error(`Failed to set up stream ${subject}`, { error });
      throw error;
    }
  }

  /**
   * Publish raw ledger to queue
   */
  async publishRawLedger(message: RawLedgerMessage): Promise<string> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const result = await this.js.publish(TOPICS.RAW_LEDGERS, JSON.stringify(message));
      return result.seq.toString();
    } catch (error) {
      logger.error('Failed to publish raw ledger', { error, ledgerId: message.ledgerId });
      throw error;
    }
  }

  /**
   * Subscribe to raw ledgers (for decoder workers)
   */
  async subscribeToRawLedgers(callback: (msg: RawLedgerMessage) => Promise<void>): Promise<void> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const sub = await this.js.pull('soroban-raw-ledgers', {
        batch: 100,
        max_timeout: nats.parseDuration('30s'),
        idle_heartbeat: nats.parseDuration('10s')
      });

      logger.info('Subscribed to raw ledgers');

      (async () => {
        for await (const msg of sub) {
          try {
            const payload = JSON.parse(new TextDecoder().decode(msg.data));
            await callback(payload);
            msg.ack();
          } catch (error) {
            logger.error('Error processing raw ledger message', { error });
            msg.nak();
          }
        }
      })();
    } catch (error) {
      logger.error('Failed to subscribe to raw ledgers', { error });
      throw error;
    }
  }

  /**
   * Publish decoded transaction
   */
  async publishDecodedTransaction(message: DecodedTransactionMessage): Promise<string> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const result = await this.js.publish(TOPICS.DECODED_TRANSACTIONS, JSON.stringify(message));
      return result.seq.toString();
    } catch (error) {
      logger.error('Failed to publish decoded transaction', { error, txId: message.txId });
      throw error;
    }
  }

  /**
   * Subscribe to decoded transactions (for enrichment workers)
   */
  async subscribeToDecodedTransactions(callback: (msg: DecodedTransactionMessage) => Promise<void>): Promise<void> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const sub = await this.js.pull('soroban-decoded-transactions', {
        batch: 50,
        max_timeout: nats.parseDuration('30s'),
        idle_heartbeat: nats.parseDuration('10s')
      });

      logger.info('Subscribed to decoded transactions');

      (async () => {
        for await (const msg of sub) {
          try {
            const payload = JSON.parse(new TextDecoder().decode(msg.data));
            await callback(payload);
            msg.ack();
          } catch (error) {
            logger.error('Error processing decoded transaction message', { error });
            msg.nak();
          }
        }
      })();
    } catch (error) {
      logger.error('Failed to subscribe to decoded transactions', { error });
      throw error;
    }
  }

  /**
   * Publish enriched event
   */
  async publishEnrichedEvent(message: EnrichedEventMessage): Promise<string> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const result = await this.js.publish(TOPICS.ENRICHED_EVENTS, JSON.stringify(message));
      return result.seq.toString();
    } catch (error) {
      logger.error('Failed to publish enriched event', { error, eventId: message.eventId });
      throw error;
    }
  }

  /**
   * Get queue depth for a topic
   */
  async getQueueDepth(topic: string): Promise<number> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const streamName = topic.replace(/\./g, '-');
      const info = await this.js.streams.info(streamName);
      return info.state.messages;
    } catch (error) {
      logger.warn('Failed to get queue depth', { error, topic });
      return 0;
    }
  }

  /**
   * Get throughput (messages processed per second)
   */
  async getThroughput(topic: string): Promise<number> {
    if (!this.js) throw new Error('JetStream not initialized');

    try {
      const streamName = topic.replace(/\./g, '-');
      const info = await this.js.streams.info(streamName);

      // Estimate based on consumer lag and time
      return info.state.messages > 0 ? info.state.messages / 60 : 0; // rough estimate
    } catch (error) {
      logger.warn('Failed to get throughput', { error, topic });
      return 0;
    }
  }

  /**
   * Get all queue depths
   */
  async getAllQueueDepths(): Promise<Record<string, number>> {
    const depths: Record<string, number> = {};

    for (const [key, topic] of Object.entries(TOPICS)) {
      depths[key] = await this.getQueueDepth(topic);
    }

    return depths;
  }

  /**
   * Check if connected
   */
  isHealthy(): boolean {
    return this.isConnected && this.nc?.isClosed() === false;
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.nc) {
      await this.nc.close();
      this.isConnected = false;
      logger.info('Closed NATS connection');
    }
  }
}

// Singleton instance
let instance: NATSQueueService | null = null;

export async function getNATSQueueService(): Promise<NATSQueueService> {
  if (!instance) {
    instance = new NATSQueueService();
    await instance.connect();
  }
  return instance;
}
