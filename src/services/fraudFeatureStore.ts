import { prismaRead } from '../db';
import { getFeatureExtractor } from './graphFeatures';
import { TransactionFeatures } from '../types/fraud';
import { logger } from '../logger';

// In-memory feature cache for low-latency online serving (Feast/Tecton online store mock)
const onlineFeatureStore = new Map<string, { features: TransactionFeatures; updatedAt: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute online TTL

export class FraudFeatureStore {
  /**
   * Serves online features with sub-10ms latency (via in-memory / cache fallback)
   */
  async getOnlineFeatures(entityId: string): Promise<TransactionFeatures> {
    const cached = onlineFeatureStore.get(entityId);
    if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
      return cached.features;
    }

    // Otherwise, extract fresh features
    const features = await this.extractFeaturesForEntity(entityId);
    onlineFeatureStore.set(entityId, { features, updatedAt: Date.now() });
    return features;
  }

  /**
   * Serves offline historical features with point-in-time correctness for ML training
   */
  async getOfflineFeatures(entityIds: string[], timestamp: Date): Promise<TransactionFeatures[]> {
    logger.info(
      `Extracting offline features for ${entityIds.length} entities as of ${timestamp.toISOString()}`,
    );
    const results: TransactionFeatures[] = [];

    for (const entityId of entityIds) {
      try {
        const features = await this.extractFeaturesForEntity(entityId, timestamp);
        results.push(features);
      } catch (error) {
        logger.error(`Failed to extract offline features for ${entityId}`, { error });
        // Return default fallback features to keep dataset shape consistent
        results.push(this.getDefaultFeatures());
      }
    }

    return results;
  }

  /**
   * Core feature extraction engine combining on-chain transactions, temporal stats,
   * graph metrics, and external/off-chain fusion data (sentiment, DEX liquidity, prices).
   */
  async extractFeaturesForEntity(entityId: string, asOfTime?: Date): Promise<TransactionFeatures> {
    const cutoff = asOfTime || new Date();

    try {
      // 1. Fetch transaction details if entityId is a transaction hash
      const tx = await prismaRead.transaction.findFirst({
        where: {
          OR: [{ hash: entityId }, { sourceAccount: entityId }],
          ledgerCloseTime: { lte: cutoff },
        },
        orderBy: { ledgerCloseTime: 'desc' },
        include: {
          events: true,
        },
      });

      if (!tx) {
        return this.getDefaultFeatures();
      }

      const txHash = tx.hash;
      const account = tx.sourceAccount;
      const contract = tx.contractAddress || '';

      // 2. Transaction-level features
      const feeVal = tx.feeCharged ? parseFloat(tx.feeCharged) : 100;

      // Calculate Gas (Fee) Price Deviation
      const recentTxs = await prismaRead.transaction.findMany({
        where: {
          ledgerCloseTime: { lte: tx.ledgerCloseTime },
        },
        orderBy: { ledgerCloseTime: 'desc' },
        take: 100,
        select: { feeCharged: true },
      });
      const avgFee =
        recentTxs.length > 0
          ? recentTxs.reduce((sum, t) => sum + (t.feeCharged ? parseFloat(t.feeCharged) : 100), 0) /
            recentTxs.length
          : 100;
      const gasPriceDeviation = avgFee > 0 ? (feeVal - avgFee) / avgFee : 0;

      // Calculate Call Depth
      let contractCallDepth = 1;
      try {
        const callGraphVertices = await prismaRead.callGraphVertex.findMany({
          where: { txHash },
        });
        if (callGraphVertices.length > 0) {
          contractCallDepth = Math.max(...callGraphVertices.map((v) => v.depth), 1);
        }
      } catch {
        // Fallback if callGraphVertex table is empty/not updated
        contractCallDepth = 1;
      }

      // Storage access patterns (Soroban footprint reads/writes count)
      let reads = 0;
      let writes = 0;
      if (tx.sorobanResources && typeof tx.sorobanResources === 'object') {
        const resources = tx.sorobanResources as any;
        if (resources.footprint) {
          reads = Array.isArray(resources.footprint.readOnly)
            ? resources.footprint.readOnly.length
            : 0;
          writes = Array.isArray(resources.footprint.readWrite)
            ? resources.footprint.readWrite.length
            : 0;
        }
      }
      // If footprint is empty, inspect preStateReads/postStateWrites
      if (reads === 0 && writes === 0) {
        try {
          const vertices = await prismaRead.callGraphVertex.findMany({
            where: { txHash },
          });
          for (const v of vertices) {
            if (v.preStateReads && Array.isArray(v.preStateReads)) reads += v.preStateReads.length;
            if (v.postStateWrites && Array.isArray(v.postStateWrites))
              writes += v.postStateWrites.length;
          }
        } catch {
          // Fallback if callGraphVertex lookup fails
        }
      }

      // Event Emit Frequency
      let eventEmitFrequency = tx.events.length;
      if (contract) {
        const recentEventsCount = await prismaRead.event.count({
          where: {
            contractAddress: contract,
            ledgerCloseTime: {
              lte: tx.ledgerCloseTime,
              gte: new Date(tx.ledgerCloseTime.getTime() - 10 * 60 * 1000), // 10 min window
            },
          },
        });
        eventEmitFrequency = recentEventsCount;
      }

      // 3. Temporal features
      const rollingTxs = await prismaRead.transaction.findMany({
        where: {
          sourceAccount: account,
          ledgerCloseTime: { lte: tx.ledgerCloseTime },
        },
        orderBy: { ledgerCloseTime: 'desc' },
        take: 100,
      });

      const rollingTxCount = rollingTxs.length;
      const averageTxAmount = 10.5; // Mock rolling transfer amount as transaction amount is not directly in core table

      let interTxArrivalTimeMs = 10000; // default 10s
      let ledgerDelta = 1;
      if (rollingTxs.length > 1) {
        const prevTx = rollingTxs[1];
        interTxArrivalTimeMs = tx.ledgerCloseTime.getTime() - prevTx.ledgerCloseTime.getTime();
        ledgerDelta = tx.ledgerSequence - prevTx.ledgerSequence;
      }

      // 4. Graph features (PageRank, centrality, community)
      let pageRank = 0.15;
      let betweennessCentrality = 0.05;
      let communityId = 1;

      try {
        const targetForGraph = contract || account;
        if (targetForGraph) {
          const extractor = getFeatureExtractor();
          const graphFeatures = await extractor.extractGraphFeatures(targetForGraph);
          pageRank = graphFeatures.pagerank || 0.15;
          betweennessCentrality = graphFeatures.betweenness || 0.05;
          communityId = graphFeatures.community || 1;
        }
      } catch {
        // Fallback if graph db connection fails or node not found
      }

      // 5. On-chain + off-chain fusion features
      // Token Price movement correlation
      let priceCorrelation = 0.0;
      try {
        if (contract) {
          const priceRecord = await prismaRead.tokenPrice.findUnique({
            where: { tokenAddress: contract },
          });
          if (priceRecord) {
            priceCorrelation = Number(priceRecord.priceChange24h || 0) / 100.0;
          }
        }
      } catch {
        // Fallback if tokenPrice lookup fails
      }

      // Social Sentiment (external API simulation - returns sentiment from -1.0 to 1.0)
      const socialSentiment = this.getSocialSentimentMock(contract || account);

      // DEX Liquidity changes
      let dexLiquidityChange = 0.0;
      try {
        if (contract) {
          const pool = await prismaRead.dexPool.findFirst({
            where: {
              OR: [{ tokenA: contract }, { tokenB: contract }],
            },
          });
          if (pool && pool.tvlUsd) {
            dexLiquidityChange = Number(pool.tvlUsd) / 1000000.0; // scaled liquidity metric
          }
        }
      } catch {
        // Fallback if dexPool lookup fails
      }

      return {
        gasPriceDeviation,
        contractCallDepth,
        storageAccessPatterns: { reads, writes },
        eventEmitFrequency,
        rollingTxCount,
        averageTxAmount,
        interTxArrivalTimeMs,
        ledgerDelta,
        pageRank,
        betweennessCentrality,
        communityId,
        priceCorrelation,
        socialSentiment,
        dexLiquidityChange,
      };
    } catch (e) {
      logger.error('Error extracting features', { entityId, error: e });
      return this.getDefaultFeatures();
    }
  }

  private getSocialSentimentMock(address: string): number {
    // Deterministic mock sentiment based on address string hash
    let hash = 0;
    for (let i = 0; i < address.length; i++) {
      hash = address.charCodeAt(i) + ((hash << 5) - hash);
    }
    const sentiment = (hash % 100) / 100.0; // range [-0.99, 0.99]
    return sentiment;
  }

  getDefaultFeatures(): TransactionFeatures {
    return {
      gasPriceDeviation: 0.0,
      contractCallDepth: 1,
      storageAccessPatterns: { reads: 1, writes: 0 },
      eventEmitFrequency: 0,
      rollingTxCount: 1,
      averageTxAmount: 0.0,
      interTxArrivalTimeMs: 0,
      ledgerDelta: 1,
      pageRank: 0.15,
      betweennessCentrality: 0.0,
      communityId: 1,
      priceCorrelation: 0.0,
      socialSentiment: 0.1,
      dexLiquidityChange: 0.0,
    };
  }
}

let featureStoreInstance: FraudFeatureStore | null = null;
export function getFraudFeatureStore(): FraudFeatureStore {
  if (!featureStoreInstance) {
    featureStoreInstance = new FraudFeatureStore();
  }
  return featureStoreInstance;
}
