import { EnsembleForecaster } from './ensemble';
import { generateDeterministicSeries } from './random';
import { ArimaSimulation, XgboostSimulation, LstmSimulation } from './models';
import { LinearTrendModel, SeasonalMeanModel } from './production-models';

export type ForecastMode = 'demo' | 'production';

export interface ForecasterOptions {
  mode?: ForecastMode;
  seed?: number;
}

let forecasterInstance: EnsembleForecaster | null = null;
let isInitializing = false;

export function createForecaster(options: ForecasterOptions = {}): EnsembleForecaster {
  const mode = options.mode ?? config.forecastMode;
  const seed = options.seed ?? config.forecastSeed;

  const models =
    mode === 'production'
      ? [new LinearTrendModel(), new SeasonalMeanModel()]
      : [new ArimaSimulation(seed), new XgboostSimulation(seed), new LstmSimulation(seed)];

  const forecaster = new EnsembleForecaster(models);
  forecaster.trainAll(generateDeterministicSeries(30, seed));
  return forecaster;
}

export async function getForecaster(): Promise<EnsembleForecaster> {
  if (!forecasterInstance || modelTrainingService.needsRetraining()) {
    if (isInitializing) {
      // Wait for initialization to complete
      while (isInitializing) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return forecasterInstance!;
    }

    isInitializing = true;
    try {
      forecasterInstance = await createForecaster();
    } finally {
      isInitializing = false;
    }
  }
  return forecasterInstance;
}

export function resetForecasterForTests(): void {
  forecasterInstance = null;
  isInitializing = false;
}

/** Deterministic PSI values for drift monitoring (no Math.random). */
export function getDeterministicDriftPsi(modelName: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < modelName.length; i++) {
    hash = (hash * 31 + modelName.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 10000;
}
