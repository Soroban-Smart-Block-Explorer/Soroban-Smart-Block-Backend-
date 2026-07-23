import { config } from '../config';
import { EnsembleForecaster } from './ensemble';
import { generateDeterministicSeries } from './random';
import { ArimaMock, XgboostMock, LstmMock } from './models';
import { LinearTrendModel, SeasonalMeanModel } from './production-models';

export type ForecastMode = 'demo' | 'production';

export interface ForecasterOptions {
  mode?: ForecastMode;
  seed?: number;
}

let forecasterInstance: EnsembleForecaster | null = null;

export function createForecaster(options: ForecasterOptions = {}): EnsembleForecaster {
  const mode = options.mode ?? config.forecastMode;
  const seed = options.seed ?? config.forecastSeed;

  const models =
    mode === 'production'
      ? [new LinearTrendModel(), new SeasonalMeanModel()]
      : [new ArimaMock(seed), new XgboostMock(seed), new LstmMock(seed)];

  const forecaster = new EnsembleForecaster(models);
  forecaster.trainAll(generateDeterministicSeries(30, seed));
  return forecaster;
}

export function getForecaster(): EnsembleForecaster {
  if (!forecasterInstance) {
    forecasterInstance = createForecaster();
  }
  return forecasterInstance;
}

export function resetForecasterForTests(): void {
  forecasterInstance = null;
}

/** Deterministic PSI values for drift monitoring (no Math.random). */
export function getDeterministicDriftPsi(modelName: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < modelName.length; i++) {
    hash = (hash * 31 + modelName.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 10000;
}
