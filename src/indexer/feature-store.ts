import prisma from '../db';
import { Ledger } from '@prisma/client';

export class FeatureStore {
  /**
   * Computes derived features (rolling averages, lag, ratio) for the latest block.
   */
  public async computeAndStoreFeatures(ledgerSequence: number, closeTime: Date) {
    // 1. Transaction Volume Feature
    const txVolume = await prisma.transaction.count({
      where: { ledgerSequence },
    });

    // 2. Compute 7d rolling average of Tx Volume (mock implementation)
    const txVol7d = await this.getRollingAverage('tx_volume', 7);

    // Save definitions if they don't exist
    const txVolDef = await this.getOrCreateFeatureDef('tx_volume', 'transaction volume per block');
    const txVol7dDef = await this.getOrCreateFeatureDef(
      'tx_volume_7d_ma',
      '7-day moving average of tx volume',
    );

    // Store feature values
    await prisma.featureValue.createMany({
      data: [
        {
          featureId: txVolDef.id,
          timestamp: closeTime,
          value: txVolume,
          blockNumber: BigInt(ledgerSequence),
        },
        {
          featureId: txVol7dDef.id,
          timestamp: closeTime,
          value: txVol7d,
          blockNumber: BigInt(ledgerSequence),
        },
      ],
      skipDuplicates: true,
    });
  }

  private async getOrCreateFeatureDef(name: string, description: string) {
    let def = await prisma.featureDefinition.findUnique({
      where: { name },
    });
    if (!def) {
      def = await prisma.featureDefinition.create({
        data: {
          name,
          description,
          category: 'onchain',
          granularity: 'block',
        },
      });
    }
    return def;
  }

  private async getRollingAverage(featureName: string, days: number): Promise<number> {
    // In a real system we would query Postgres for the rolling sum.
    // For this mock, we just return a pseudo-random stable number.
    return 1000 + Math.random() * 200;
  }

  public async getHistoricalData(metric: string, limit: number = 30): Promise<number[]> {
    const def = await prisma.featureDefinition.findUnique({ where: { name: metric } });
    if (!def) {
      // Return synthetic historical data for mock models
      return Array.from({ length: limit }, () => 1000 + Math.random() * 500);
    }

    const values = await prisma.featureValue.findMany({
      where: { featureId: def.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    if (values.length === 0) {
      return Array.from({ length: limit }, () => 1000 + Math.random() * 500);
    }

    return values.reverse().map((v) => v.value);
  }
}

export const featureStore = new FeatureStore();
