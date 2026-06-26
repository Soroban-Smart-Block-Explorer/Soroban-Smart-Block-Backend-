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
  ): ForecastResult[];

  train(historicalData: number[], features?: Record<string, number[]>): void;
}

export class ArimaMock implements IForecastingModel {
  name = 'ARIMA-auto';
  type = 'arima';
  version = '1.0.0';

  private lastValue = 0;
  private trend = 0;

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.lastValue = historicalData[historicalData.length - 1];
      if (historicalData.length > 1) {
        this.trend =
          (historicalData[historicalData.length - 1] - historicalData[0]) / historicalData.length;
      }
    }
  }

  predict(horizon: number, recentData: number[]): ForecastResult[] {
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.lastValue;
    const now = new Date();

    for (let i = 1; i <= horizon; i++) {
      // Mock ARIMA: carry forward trend with slight decay and noise
      current += this.trend * 0.9 + (Math.random() - 0.5) * (this.lastValue * 0.05);
      const targetDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);

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

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.baseValue = historicalData.reduce((a, b) => a + b, 0) / historicalData.length;
    }
  }

  predict(
    horizon: number,
    recentData: number[],
    features?: Record<string, number[]>,
  ): ForecastResult[] {
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.baseValue;
    const now = new Date();

    for (let i = 1; i <= horizon; i++) {
      // XGBoost mock typically fits non-linear patterns.
      // We will add some seasonal sine-wave mock to represent non-linear feature interactions
      const seasonality = Math.sin((i / 7) * Math.PI) * (this.baseValue * 0.1);
      current = this.baseValue + seasonality + (Math.random() - 0.5) * (this.baseValue * 0.08);

      const targetDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);

      results.push({
        timestamp: targetDate,
        predictedValue: current,
        lowerBound: current * 0.9,
        upperBound: current * 1.1,
        shapValues: {
          rolling_7d_avg: Math.random() * 0.4,
          day_of_week: Math.random() * 0.3,
          whale_activity: Math.random() * 0.2,
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

  train(historicalData: number[]) {
    if (historicalData.length > 0) {
      this.baseValue = historicalData[historicalData.length - 1];
    }
  }

  predict(horizon: number, recentData: number[]): ForecastResult[] {
    const results: ForecastResult[] = [];
    let current = recentData.length > 0 ? recentData[recentData.length - 1] : this.baseValue;
    const now = new Date();

    for (let i = 1; i <= horizon; i++) {
      // LSTM mock captures memory and momentum
      current += (this.baseValue - current) * 0.1 + (Math.random() - 0.5) * (this.baseValue * 0.03);

      const targetDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);

      const stdDev = this.baseValue * 0.02 * i; // Error grows linearly
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
