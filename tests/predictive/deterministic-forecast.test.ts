import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArimaMock, XgboostMock } from '../../src/predictive/models';
import { EnsembleForecaster } from '../../src/predictive/ensemble';
import { createForecaster } from '../../src/predictive/factory';
import { LinearTrendModel, SeasonalMeanModel } from '../../src/predictive/production-models';

const FIXED_NOW = new Date('2024-06-01T00:00:00.000Z');
const SAMPLE_DATA = [1000, 1050, 980, 1020, 1100, 1080, 990, 1010, 1070, 1040];

function normalizeForecast(results: ReturnType<EnsembleForecaster['predict']>) {
  return results.map((r) => ({
    predictedValue: Number(r.predictedValue.toFixed(6)),
    lowerBound: Number(r.lowerBound.toFixed(6)),
    upperBound: Number(r.upperBound.toFixed(6)),
    timestamp: r.timestamp.toISOString(),
  }));
}

describe('demo forecast models (seeded)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ArimaMock produces identical output for the same seed and input', () => {
    const a = new ArimaMock(42);
    const b = new ArimaMock(42);
    a.train(SAMPLE_DATA);
    b.train(SAMPLE_DATA);

    const runA = normalizeForecast(a.predict(5, SAMPLE_DATA, undefined, FIXED_NOW));
    const runB = normalizeForecast(b.predict(5, SAMPLE_DATA, undefined, FIXED_NOW));
    expect(runA).toMatchSnapshot();
    expect(runA).toEqual(runB);
    expect(runA).toEqual(normalizeForecast(a.predict(5, SAMPLE_DATA, undefined, FIXED_NOW)));
  });

  it('XgboostMock produces identical SHAP values for the same seed', () => {
    const model = new XgboostMock(99);
    model.train(SAMPLE_DATA);
    const results = model.predict(3, SAMPLE_DATA, undefined, FIXED_NOW);

    expect(
      results.map((r) => ({
        predictedValue: Number(r.predictedValue.toFixed(6)),
        shapValues: r.shapValues,
      })),
    ).toMatchSnapshot();
  });

  it('demo ensemble snapshot is stable', () => {
    const forecaster = createForecaster({ mode: 'demo', seed: 7 });
    const predictions = forecaster.predict(4, SAMPLE_DATA, 0.95, FIXED_NOW);
    expect(normalizeForecast(predictions)).toMatchSnapshot();
  });
});

describe('production forecast models', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('LinearTrendModel is fully deterministic', () => {
    const model = new LinearTrendModel();
    model.train(SAMPLE_DATA);
    const first = normalizeForecast(model.predict(5, SAMPLE_DATA, undefined, FIXED_NOW));
    const second = normalizeForecast(model.predict(5, SAMPLE_DATA, undefined, FIXED_NOW));
    expect(first).toEqual(second);
    expect(first).toMatchSnapshot();
  });

  it('production ensemble uses non-mock models', () => {
    const forecaster = createForecaster({ mode: 'production', seed: 1 });
    const names = forecaster.getModels().map((m) => m.name);
    expect(names).toEqual(['Linear-Trend', 'Seasonal-Mean']);
    expect(names).not.toContain('ARIMA-auto');
  });

  it('production ensemble snapshot is stable', () => {
    const forecaster = new EnsembleForecaster([new LinearTrendModel(), new SeasonalMeanModel()]);
    forecaster.trainAll(SAMPLE_DATA);
    expect(
      normalizeForecast(forecaster.predict(4, SAMPLE_DATA, 0.95, FIXED_NOW)),
    ).toMatchSnapshot();
  });
});
