import { PrismaClient } from '@prisma/client';
import { getGraphDb } from '../db/graph';
import { logger } from '../logger';

/**
 * Graph Sync Service
 * Handles Change Data Capture (CDC) synchronization between PostgreSQL and Apache AGE
 * Ensures eventual consistency with < 1s lag target
 */

interface SyncMetrics {
  recordsProcessed: number;
  syncStartTime: Date;
  syncEndTime: Date;
  syncDurationMs: number;
  status: 'success' | 'error';
  errorMessage?: string;
}

export class GraphSyncService {
  private prisma: PrismaClient;
  private graphDb;
  private isRunning: boolean = false;
  private syncInterval: number = 1000; // 1 second
  private batchSize: number = 100;

  constructor() {
    this.prisma = new PrismaClient();
    this.graphDb = getGraphDb();
  }

  /**
   * Start the sync service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Graph sync service already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting graph sync service');

    // Initial backfill
    await this.backfillHistoricalData();

    // Start continuous sync
    this.syncLoop();
  }

  /**
   * Stop the sync service
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('Stopping graph sync service');
  }

  /**
   * Main sync loop
   */
  private async syncLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.syncChanges();
        await this.sleep(this.syncInterval);
      } catch (error) {
        logger.error('Error in sync loop:', error);
        await this.sleep(this.syncInterval * 5); // Back off on error
      }
    }
  }

  /**
   * Sync changes from PostgreSQL to Graph DB
   */
  private async syncChanges(): Promise<void> {
    const startTime = Date.now();
    let recordsProcessed = 0;

    try {
      // Sync transactions
      recordsProcessed += await this.syncTransactions();

      // Sync contracts
      recordsProcessed += await this.syncContracts();

      // Sync events
      recordsProcessed += await this.syncEvents();

      // Sync token transfers
      recordsProcessed += await this.syncTokenTransfers();

      // Sync contract calls
      recordsProcessed += await this.syncContractCalls();

      // Log sync metrics
      await this.logSyncMetrics('incremental', 'multiple', recordsProcessed, startTime, 'success');

      const syncDuration = Date.now() - startTime;
      if (syncDuration > 1000) {
        logger.warn(`Sync took ${syncDuration}ms (> 1s target)`);
      }
    } catch (error) {
      await this.logSyncMetrics('incremental', 'multiple', recordsProcessed, startTime, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Backfill historical data
   */
  private async backfillHistoricalData(): Promise<void> {
    logger.info('Starting historical data backfill');
    const startTime = Date.now();
    let totalRecords = 0;

    try {
      // Backfill contracts
      totalRecords += await this.backfillContracts();

      // Backfill transactions
      totalRecords += await this.backfillTransactions();

      // Backfill events
      totalRecords += await this.backfillEvents();

      // Backfill token transfers
      totalRecords += await this.backfillTokenTransfers();

      // Backfill contract calls
      totalRecords += await this.backfillContractCalls();

      const duration = Date.now() - startTime;
      logger.info(`Backfill completed: ${totalRecords} records in ${duration}ms`);
      
      await this.logSyncMetrics('backfill', 'multiple', totalRecords, startTime, 'success');
    } catch (error) {
      logger.error('Backfill failed:', error);
      await this.logSyncMetrics('backfill', 'multiple', totalRecords, startTime, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Sync transactions
   */
  private async syncTransactions(): Promise<number> {
    // Get recent transactions (last 5 seconds)
    const recentTime = new Date(Date.now() - 5000);
    const transactions = await this.prisma.transaction.findMany({
      where: {
        createdAt: { gte: recentTime },
      },
      take: this.batchSize,
    });

    for (const tx of transactions) {
      // Create wallet node
      await this.graphDb.upsertNode('Wallet', {
        id: tx.sourceAccount,
        address: tx.sourceAccount,
        type: 'user',
        firstSeen: tx.ledgerCloseTime,
        lastActive: tx.ledgerCloseTime,
      });

      // Create transaction node
      await this.graphDb.upsertNode('Transaction', {
        id: tx.hash,
        hash: tx.hash,
        ledgerSequence: tx.ledgerSequence,
        timestamp: tx.ledgerCloseTime,
        status: tx.status,
        fee: tx.feeCharged,
      });

      // Create SENT edge
      await this.graphDb.upsertEdge(
        'Wallet',
        tx.sourceAccount,
        'SENT',
        'Transaction',
        tx.hash,
        {
          timestamp: tx.ledgerCloseTime,
          fee: tx.feeCharged,
        }
      );

      // Create contract node and CALLS edge if applicable
      if (tx.contractAddress) {
        await this.graphDb.upsertNode('Contract', {
          id: tx.contractAddress,
          address: tx.contractAddress,
          type: 'contract',
        });

        await this.graphDb.upsertEdge(
          'Transaction',
          tx.hash,
          'CALLS',
          'Contract',
          tx.contractAddress,
          {
            functionName: tx.functionName,
            gasUsed: tx.sorobanResources?.cpuInstructions || 0,
            success: tx.status === 'SUCCESS',
          }
        );
      }
    }

    return transactions.length;
  }

  /**
   * Sync contracts
   */
  private async syncContracts(): Promise<number> {
    const recentTime = new Date(Date.now() - 5000);
    const contracts = await this.prisma.contract.findMany({
      where: {
        createdAt: { gte: recentTime },
      },
      take: this.batchSize,
    });

    for (const contract of contracts) {
      await this.graphDb.upsertNode('Contract', {
        id: contract.address,
        address: contract.address,
        name: contract.name,
        type: contract.isToken ? 'token' : 'contract',
        verified: contract.isVerified,
        tokenSymbol: contract.tokenSymbol,
        tokenName: contract.tokenName,
        tokenDecimals: contract.tokenDecimals,
      });

      if (contract.isToken) {
        await this.graphDb.upsertNode('Token', {
          id: contract.address,
          address: contract.address,
          symbol: contract.tokenSymbol,
          name: contract.tokenName,
          decimals: contract.tokenDecimals,
        });
      }
    }

    return contracts.length;
  }

  /**
   * Sync events
   */
  private async syncEvents(): Promise<number> {
    const recentTime = new Date(Date.now() - 5000);
    const events = await this.prisma.event.findMany({
      where: {
        createdAt: { gte: recentTime },
      },
      take: this.batchSize,
    });

    for (const event of events) {
      await this.graphDb.upsertNode('Event', {
        id: event.id,
        eventType: event.eventType,
        topicSymbol: event.topicSymbol,
        topics: event.topics,
        data: event.data,
        ledgerSequence: event.ledgerSequence,
        timestamp: event.ledgerCloseTime,
      });

      // Create EMITS edge
      await this.graphDb.upsertEdge(
        'Contract',
        event.contractAddress,
        'EMITS',
        'Event',
        event.id,
        {
          eventType: event.eventType,
          topicCount: Array.isArray(event.topics) ? event.topics.length : 0,
        }
      );
    }

    return events.length;
  }

  /**
   * Sync token transfers
   */
  private async syncTokenTransfers(): Promise<number> {
    // This would be implemented based on your token transfer tracking logic
    // For now, return 0 as this depends on specific event patterns
    return 0;
  }

  /**
   * Sync contract calls
   */
  private async syncContractCalls(): Promise<number> {
    // This would be implemented based on your contract call tracking logic
    // For now, return 0 as this depends on specific event patterns
    return 0;
  }

  /**
   * Backfill contracts
   */
  private async backfillContracts(): Promise<number> {
    const contracts = await this.prisma.contract.findMany({
      take: this.batchSize,
      orderBy: { createdAt: 'asc' },
    });

    for (const contract of contracts) {
      await this.graphDb.upsertNode('Contract', {
        id: contract.address,
        address: contract.address,
        name: contract.name,
        type: contract.isToken ? 'token' : 'contract',
        verified: contract.isVerified,
        tokenSymbol: contract.tokenSymbol,
        tokenName: contract.tokenName,
        tokenDecimals: contract.tokenDecimals,
      });

      if (contract.isToken) {
        await this.graphDb.upsertNode('Token', {
          id: contract.address,
          address: contract.address,
          symbol: contract.tokenSymbol,
          name: contract.tokenName,
          decimals: contract.tokenDecimals,
        });
      }
    }

    return contracts.length;
  }

  /**
   * Backfill transactions
   */
  private async backfillTransactions(): Promise<number> {
    const transactions = await this.prisma.transaction.findMany({
      take: this.batchSize,
      orderBy: { createdAt: 'asc' },
    });

    for (const tx of transactions) {
      await this.graphDb.upsertNode('Wallet', {
        id: tx.sourceAccount,
        address: tx.sourceAccount,
        type: 'user',
        firstSeen: tx.ledgerCloseTime,
        lastActive: tx.ledgerCloseTime,
      });

      await this.graphDb.upsertNode('Transaction', {
        id: tx.hash,
        hash: tx.hash,
        ledgerSequence: tx.ledgerSequence,
        timestamp: tx.ledgerCloseTime,
        status: tx.status,
        fee: tx.feeCharged,
      });

      await this.graphDb.upsertEdge(
        'Wallet',
        tx.sourceAccount,
        'SENT',
        'Transaction',
        tx.hash,
        {
          timestamp: tx.ledgerCloseTime,
          fee: tx.feeCharged,
        }
      );

      if (tx.contractAddress) {
        await this.graphDb.upsertNode('Contract', {
          id: tx.contractAddress,
          address: tx.contractAddress,
          type: 'contract',
        });

        await this.graphDb.upsertEdge(
          'Transaction',
          tx.hash,
          'CALLS',
          'Contract',
          tx.contractAddress,
          {
            functionName: tx.functionName,
            gasUsed: tx.sorobanResources?.cpuInstructions || 0,
            success: tx.status === 'SUCCESS',
          }
        );
      }
    }

    return transactions.length;
  }

  /**
   * Backfill events
   */
  private async backfillEvents(): Promise<number> {
    const events = await this.prisma.event.findMany({
      take: this.batchSize,
      orderBy: { createdAt: 'asc' },
    });

    for (const event of events) {
      await this.graphDb.upsertNode('Event', {
        id: event.id,
        eventType: event.eventType,
        topicSymbol: event.topicSymbol,
        topics: event.topics,
        data: event.data,
        ledgerSequence: event.ledgerSequence,
        timestamp: event.ledgerCloseTime,
      });

      await this.graphDb.upsertEdge(
        'Contract',
        event.contractAddress,
        'EMITS',
        'Event',
        event.id,
        {
          eventType: event.eventType,
          topicCount: Array.isArray(event.topics) ? event.topics.length : 0,
        }
      );
    }

    return events.length;
  }

  /**
   * Backfill token transfers
   */
  private async backfillTokenTransfers(): Promise<number> {
    // Implementation depends on token transfer tracking
    return 0;
  }

  /**
   * Backfill contract calls
   */
  private async backfillContractCalls(): Promise<number> {
    // Implementation depends on contract call tracking
    return 0;
  }

  /**
   * Log sync metrics to database
   */
  private async logSyncMetrics(
    syncType: string,
    sourceTable: string,
    recordsProcessed: number,
    startTime: number,
    status: 'success' | 'error',
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO graph_sync_log (sync_type, source_table, records_processed, sync_start_time, sync_end_time, sync_duration_ms, status, error_message)
        VALUES (
          ${syncType},
          ${sourceTable},
          ${recordsProcessed},
          ${new Date(startTime)},
          ${new Date()},
          ${Date.now() - startTime},
          ${status},
          ${errorMessage || null}
        )
      `;
    } catch (error) {
      logger.error('Failed to log sync metrics:', error);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let graphSyncService: GraphSyncService | null = null;

export function getGraphSyncService(): GraphSyncService {
  if (!graphSyncService) {
    graphSyncService = new GraphSyncService();
  }
  return graphSyncService;
}

export function resetGraphSyncService(): void {
  graphSyncService = null;
}
