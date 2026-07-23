import { IForecastingModel, ForecastResult } from './models';

export class EnsembleForecaster {
  private models: IForecastingModel[];

  constructor(models?: IForecastingModel[]) {
    this.models = models ?? [];
  }

  public trainAll(historicalData: number[], features?: Record<string, number[]>) {
    for (const model of this.models) {
      model.train(historicalData, features);
    }
  }

  public predict(
    horizon: number,
    recentData: number[],
    confidenceLevel = 0.95,
    referenceDate: Date = new Date(),
  ): ForecastResult[] {
    const allPredictions = this.models.map((m) =>
      m.predict(horizon, recentData, undefined, referenceDate),
    );

    const weights = this.models.map(() => 1 / this.models.length);
    const ensembleResults: ForecastResult[] = [];

    for (let i = 0; i < horizon; i++) {
      let weightedPrediction = 0;
      let minLower = Infinity;
      let maxUpper = -Infinity;

      for (let m = 0; m < this.models.length; m++) {
        const pred = allPredictions[m][i];
        weightedPrediction += pred.predictedValue * weights[m];
        if (pred.lowerBound < minLower) minLower = pred.lowerBound;
        if (pred.upperBound > maxUpper) maxUpper = pred.upperBound;
      }

      const multiplier = confidenceLevel / 0.95;
      const center = weightedPrediction;
      const lower = center - (center - minLower) * multiplier;
      const upper = center + (maxUpper - center) * multiplier;

      ensembleResults.push({
        timestamp: allPredictions[0][i].timestamp,
        predictedValue: weightedPrediction,
        lowerBound: lower,
        upperBound: upper,
        featuresUsed: {
          ensemble_size: this.models.length,
        },
      });
    }

    return ensembleResults;
  }

  public getModels() {
    return this.models.map((m) => ({
      name: m.name,
      type: m.type,
      version: m.version,
    }));
  }
}
