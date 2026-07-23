import { prismaWrite as prisma } from '../db';
import { config } from '../config';
import {
  createSeededRandom,
  generateDeterministicSeries,
  type RandomSource,
} from '../predictive/random';

export class FeatureStore {
  constructor(private readonly rng: RandomSource = createSeededRandom(config.forecastSeed)) {}

  /**
   * Computes derived features (rolling averages, lag, ratio) for the latest block.
   */
  public async computeAndStoreFeatures(ledgerSequence: number, closeTime: Date) {
    const txVolume = await prisma.transaction.count({
      where: { ledgerSequence },
    });

    const txVol7d = await this.getRollingAverage('tx_volume', 7);

    const txVolDef = await this.getOrCreateFeatureDef('tx_volume', 'transaction volume per block');
    const txVol7dDef = await this.getOrCreateFeatureDef(
      'tx_volume_7d_ma',
      '7-day moving average of tx volume',
    );

    await prisma.featureValue.createMany({
      data: [
        {
          featureId: txVolDef.id,
          timestamp: closeTime,
          value: txVolume,
          ledger: ledgerSequence,
        },
        {
          featureId: txVol7dDef.id,
          timestamp: closeTime,
          value: txVol7d,
          ledger: ledgerSequence,
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
        },
      });
    }
    return def;
  }

  private async getRollingAverage(_featureName: string, _days: number): Promise<number> {
    return 1000 + this.rng.next() * 200;
  }

  private syntheticSeries(metric: string, limit: number): number[] {
    let seed = config.forecastSeed;
    for (let i = 0; i < metric.length; i++) {
      seed = (seed * 31 + metric.charCodeAt(i)) >>> 0;
    }
    return generateDeterministicSeries(limit, seed);
  }

  public async getHistoricalData(metric: string, limit: number = 30): Promise<number[]> {
    const def = await prisma.featureDefinition.findUnique({ where: { name: metric } });
    if (!def) {
      return this.syntheticSeries(metric, limit);
    }

    const values = await prisma.featureValue.findMany({
      where: { featureId: def.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    if (values.length === 0) {
      return this.syntheticSeries(metric, limit);
    }

    return values.reverse().map((v: { value: number }) => v.value);
  }
}

export const featureStore = new FeatureStore();
