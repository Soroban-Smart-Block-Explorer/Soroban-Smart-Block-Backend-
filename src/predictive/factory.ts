import { EnsembleForecaster } from './ensemble';
import { modelTrainingService } from './training-service';

export type ForecastMode = 'demo' | 'production';

export interface ForecasterOptions {
  mode?: ForecastMode;
  seed?: number;
}

let forecasterInstance: EnsembleForecaster | null = null;
let isInitializing = false;

export async function createForecaster(
  _options: ForecasterOptions = {},
): Promise<EnsembleForecaster> {
  // Use the training service to properly initialize and train models
  return await modelTrainingService.initializeModels();
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
