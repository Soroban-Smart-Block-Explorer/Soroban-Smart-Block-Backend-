import type { RandomSource } from './random';
import { createSeededRandom, mathRandomSource } from './random';

export interface ForecastResult {
  timestamp: Date;
  predictedValue: number;
  lowerBound: number;
  upperBound: number;
  featuresUsed?: Record<string, number>;
  shapValues?: Record<string, number>;
}

export interface IForecastingModel {
  name: string;
  type: string;
  version: string;

  predict(
    horizon: number,
    recentData: number[],
    features?: Record<string, number[]>,
    referenceDate?: Date,
  ): ForecastResult[];

  train(historicalData: number[], features?: Record<string, number[]>): void;
}

function rngForPrediction(seed: number | undefined, recentData: number[]): RandomSource {
  if (seed === undefined) {
    return mathRandomSource;
  }
  let hash = seed >>> 0;
  for (const value of recentData) {
    hash = (hash * 31 + Math.floor(value)) >>> 0;
  }
  return createSeededRandom(hash);
}

export class ArimaMock implements IForecastingModel {
  name = 'ARIMA-auto';
  type = 'arima';
  version = '1.0.0';

  private lastValue = 0;
  private trend = 0;

  constructor(private readonly seed?: number) {}

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.lastValue = historicalData[historicalData.length - 1];
      if (historicalData.length > 1) {
        this.trend =
          (historicalData[historicalData.length - 1] - historicalData[0]) / historicalData.length;
      }
    }
  }

  predict(
    horizon: number,
    recentData: number[],
    _features?: Record<string, number[]>,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const rng = rngForPrediction(this.seed, recentData);
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.lastValue;

    for (let i = 1; i <= horizon; i++) {
      current += this.trend * 0.9 + (rng.next() - 0.5) * (this.lastValue * 0.05);
      const targetDate = new Date(referenceDate.getTime() + i * 24 * 60 * 60 * 1000);

      const stdDev = this.lastValue * 0.05 * Math.sqrt(i);
      results.push({
        timestamp: targetDate,
        predictedValue: current,
        lowerBound: current - 1.96 * stdDev,
        upperBound: current + 1.96 * stdDev,
      });
    }
    return results;
  }
}

export class XgboostMock implements IForecastingModel {
  name = 'XGBoost-Regressor';
  type = 'xgboost';
  version = '1.2.0';

  private baseValue = 0;

  constructor(private readonly seed?: number) {}

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.baseValue = historicalData.reduce((a, b) => a + b, 0) / historicalData.length;
    }
  }

  predict(
    horizon: number,
    recentData: number[],
    _features?: Record<string, number[]>,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const rng = rngForPrediction(this.seed, recentData);
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.baseValue;

    for (let i = 1; i <= horizon; i++) {
      const seasonality = Math.sin((i / 7) * Math.PI) * (this.baseValue * 0.1);
      current = this.baseValue + seasonality + (rng.next() - 0.5) * (this.baseValue * 0.08);
      const targetDate = new Date(referenceDate.getTime() + i * 24 * 60 * 60 * 1000);

      results.push({
        timestamp: targetDate,
        predictedValue: current,
        lowerBound: current * 0.9,
        upperBound: current * 1.1,
        shapValues: {
          rolling_7d_avg: rng.next() * 0.4,
          day_of_week: rng.next() * 0.3,
          whale_activity: rng.next() * 0.2,
        },
      });
    }
    return results;
  }
}

export class LstmMock implements IForecastingModel {
  name = 'LSTM-Attention';
  type = 'lstm';
  version = '2.0.0';

  private baseValue = 0;

  constructor(private readonly seed?: number) {}

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.baseValue = historicalData[historicalData.length - 1];
    }
  }

  predict(
    horizon: number,
    recentData: number[],
    _features?: Record<string, number[]>,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const rng = rngForPrediction(this.seed, recentData);
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.baseValue;

    for (let i = 1; i <= horizon; i++) {
      current += (this.baseValue - current) * 0.1 + (rng.next() - 0.5) * (this.baseValue * 0.03);
      const targetDate = new Date(referenceDate.getTime() + i * 24 * 60 * 60 * 1000);

      const stdDev = this.baseValue * 0.02 * i;
      results.push({
        timestamp: targetDate,
        predictedValue: current,
        lowerBound: current - 1.96 * stdDev,
        upperBound: current + 1.96 * stdDev,
      });
    }
    return results;
  }
}
