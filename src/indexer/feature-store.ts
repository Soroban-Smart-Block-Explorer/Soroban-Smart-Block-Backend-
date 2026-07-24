import { prismaWrite as prisma } from '../db';

export class FeatureStore {
  constructor() {}

  /**
   * Computes derived features for the latest block from actual indexed data.
   */
  public async computeAndStoreFeatures(ledgerSequence: number, closeTime: Date) {
    const ledger = await prisma.ledger.findUnique({ where: { sequence: ledgerSequence } });
    const txCount = ledger?.txCount ?? 0;

    const [txVolume, uniqueSourceAccounts, contractsWithEvents, failedTxs] = await Promise.all([
      prisma.transaction.count({ where: { ledgerSequence } }),
      prisma.transaction.findMany({
        where: { ledgerSequence },
        select: { sourceAccount: true },
        distinct: ['sourceAccount'],
      }),
      prisma.event.findMany({
        where: { ledgerSequence },
        select: { contractAddress: true },
        distinct: ['contractAddress'],
      }),
      prisma.transaction.count({ where: { ledgerSequence, status: { not: 'success' } } }),
    ]);

    const failureRatio = txCount > 0 ? Number((failedTxs / txCount).toFixed(6)) : 0;

    const latestLedger = await prisma.ledger.findFirst({ orderBy: { sequence: 'desc' } });
    const freshnessSeconds = latestLedger
      ? Number(((closeTime.getTime() - latestLedger.closeTime.getTime()) / 1000).toFixed(3))
      : 0;

    const txVolume7dAvg = await this.compute7dMovingAverage('tx_volume');

    const features = [
      { name: 'tx_volume', value: txVolume, description: 'transaction count for the ledger' },
      {
        name: 'unique_source_accounts',
        value: uniqueSourceAccounts.length,
        description: 'distinct source accounts in ledger',
      },
      {
        name: 'contracts_with_events',
        value: contractsWithEvents.length,
        description: 'distinct contract addresses emitting events',
      },
      {
        name: 'tx_failure_ratio',
        value: failureRatio,
        description: 'failed tx ratio for ledger',
      },
      {
        name: 'data_freshness_seconds',
        value: freshnessSeconds,
        description: 'seconds since latest indexed ledger close',
      },
      {
        name: 'tx_volume_7d_ma',
        value: txVolume7dAvg,
        description: '7-day simple moving average of tx volume',
      },
    ];

    const rows = await Promise.all(
      features.map(async (feature) => {
        const def = await this.getOrCreateFeatureDef(feature.name, feature.description);
        return {
          featureId: def.id,
          timestamp: closeTime,
          value: feature.value,
          ledger: ledgerSequence,
        };
      }),
    );

    await prisma.featureValue.createMany({ data: rows, skipDuplicates: true });
  }

  private async getOrCreateFeatureDef(name: string, description: string) {
    let def = await prisma.featureDefinition.findUnique({ where: { name } });
    if (!def) {
      def = await prisma.featureDefinition.create({
        data: { name, description, category: 'onchain' },
      });
    }
    return def;
  }

  private async compute7dMovingAverage(featureName: string): Promise<number> {
    const def = await prisma.featureDefinition.findUnique({ where: { name: featureName } });
    if (!def) {
      return 0;
    }

    const values = await prisma.featureValue.findMany({
      where: { featureId: def.id },
      orderBy: { timestamp: 'desc' },
      take: 7,
    });

    const recent = values.map((value) => value.value);
    if (recent.length === 0) {
      return 0;
    }

    const sum = recent.reduce((acc, val) => acc + val, 0);
    return Number((sum / recent.length).toFixed(6));
  }

  public async getHistoricalData(metric: string, limit: number = 30): Promise<number[]> {
    const def = await prisma.featureDefinition.findUnique({ where: { name: metric } });
    if (!def) {
      return [];
    }

    const values = await prisma.featureValue.findMany({
      where: { featureId: def.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return values.map((value) => value.value);
  }
}

export const featureStore = new FeatureStore();
