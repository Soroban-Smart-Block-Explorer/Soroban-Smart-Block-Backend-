import { IForecastingModel, ForecastResult, ArimaMock, XgboostMock, LstmMock } from './models';

export class EnsembleForecaster {
  private models: IForecastingModel[];

  constructor() {
    this.models = [new ArimaMock(), new XgboostMock(), new LstmMock()];
  }

  public trainAll(historicalData: number[], features?: Record<string, number[]>) {
    for (const model of this.models) {
      model.train(historicalData, features);
    }
  }

  public predict(horizon: number, recentData: number[], confidenceLevel = 0.95): ForecastResult[] {
    // Generate predictions from all models
    const allPredictions = this.models.map((m) => m.predict(horizon, recentData));

    // Calculate ensemble weights based on mocked Bayesian optimization / recent accuracy
    // For simplicity, we just average them
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

      // Conformal prediction interval simulation based on confidenceLevel
      // We widen the bounds if confidenceLevel is higher (e.g. 0.99)
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
