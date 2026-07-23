import { ForecastResult, IForecastingModel } from './models';

function linearTrend(historicalData: number[]): { intercept: number; slope: number } {
  if (historicalData.length === 0) {
    return { intercept: 0, slope: 0 };
  }
  if (historicalData.length === 1) {
    return { intercept: historicalData[0], slope: 0 };
  }

  const n = historicalData.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += historicalData[i];
    sumXY += i * historicalData[i];
    sumXX += i * i;
  }

  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { intercept, slope };
}

export class LinearTrendModel implements IForecastingModel {
  name = 'Linear-Trend';
  type = 'linear';
  version = '1.0.0';

  private intercept = 0;
  private slope = 0;
  private lastValue = 0;

  train(historicalData: number[]) {
    const trend = linearTrend(historicalData);
    this.intercept = trend.intercept;
    this.slope = trend.slope;
    this.lastValue = historicalData.length > 0 ? historicalData[historicalData.length - 1] : 0;
  }

  predict(
    horizon: number,
    recentData: number[],
    _features?: Record<string, number[]>,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const baseIndex = recentData.length > 0 ? recentData.length - 1 : 0;
    const results: ForecastResult[] = [];

    for (let i = 1; i <= horizon; i++) {
      const predicted = this.intercept + this.slope * (baseIndex + i);
      const residual = Math.abs(this.lastValue * 0.05);
      const targetDate = new Date(referenceDate.getTime() + i * 24 * 60 * 60 * 1000);

      results.push({
        timestamp: targetDate,
        predictedValue: predicted,
        lowerBound: predicted - residual,
        upperBound: predicted + residual,
      });
    }

    return results;
  }
}

export class SeasonalMeanModel implements IForecastingModel {
  name = 'Seasonal-Mean';
  type = 'seasonal';
  version = '1.0.0';

  private mean = 0;

  train(historicalData: number[]) {
    this.mean =
      historicalData.length > 0
        ? historicalData.reduce((sum, value) => sum + value, 0) / historicalData.length
        : 0;
  }

  predict(
    horizon: number,
    recentData: number[],
    _features?: Record<string, number[]>,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const anchor = recentData.length > 0 ? recentData[recentData.length - 1] : this.mean;
    const results: ForecastResult[] = [];

    for (let i = 1; i <= horizon; i++) {
      const seasonality = Math.sin((i / 7) * Math.PI) * (this.mean * 0.1);
      const predicted = anchor * 0.7 + this.mean * 0.3 + seasonality;
      const targetDate = new Date(referenceDate.getTime() + i * 24 * 60 * 60 * 1000);

      results.push({
        timestamp: targetDate,
        predictedValue: predicted,
        lowerBound: predicted * 0.95,
        upperBound: predicted * 1.05,
        shapValues: {
          rolling_7d_avg: 0.35,
          day_of_week: 0.25,
          whale_activity: 0.1,
        },
      });
    }

    return results;
  }
}
