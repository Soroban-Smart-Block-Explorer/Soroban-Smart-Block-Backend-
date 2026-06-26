export interface SMAInput {
  prices: number[];
  period: number;
}

export interface EMAInput {
  prices: number[];
  period: number;
}

export interface RSIInput {
  prices: number[];
  period: number;
}

export interface MACDInput {
  prices: number[];
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface BollingerBandsInput {
  prices: number[];
  period: number;
  stdDev: number;
}

export interface TechnicalIndicators {
  sma: Record<number, number>;
  ema: Record<number, number>;
  rsi: number;
  macd: {
    macdLine: number;
    signalLine: number;
    histogram: number;
  };
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  };
}

export function computeSMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const result: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += prices[j];
    }
    result.push(sum / period);
  }
  return result;
}

export function computeEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  result.push(sum / period);

  for (let i = period; i < prices.length; i++) {
    const ema = (prices[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
    result.push(ema);
  }

  return result;
}

export function computeRSI(prices: number[], period: number = 14): number | null {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeMACD(
  prices: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { macdLine: number; signalLine: number; histogram: number } | null {
  const fastEMA = computeEMA(prices, fastPeriod);
  const slowEMA = computeEMA(prices, slowPeriod);

  if (fastEMA.length < signalPeriod + 1 || slowEMA.length < signalPeriod + 1) return null;

  const macdLine: number[] = [];
  const startIdx = prices.length - Math.min(fastEMA.length, slowEMA.length);
  for (let i = startIdx; i < prices.length; i++) {
    const fastIdx = fastEMA.length - (prices.length - i);
    const slowIdx = slowEMA.length - (prices.length - i);
    if (fastIdx >= 0 && slowIdx >= 0) {
      macdLine.push(fastEMA[fastIdx] - slowEMA[slowIdx]);
    }
  }

  if (macdLine.length < signalPeriod) return null;
  const signalEma = computeEMA(macdLine, signalPeriod);
  if (signalEma.length === 0) return null;

  const currentMacd = macdLine[macdLine.length - 1];
  const currentSignal = signalEma[signalEma.length - 1];

  return {
    macdLine: currentMacd,
    signalLine: currentSignal,
    histogram: currentMacd - currentSignal,
  };
}

export function computeBollingerBands(
  prices: number[],
  period: number = 20,
  stdDev: number = 2,
): { upper: number; middle: number; lower: number } | null {
  if (prices.length < period) return null;

  const relevantPrices = prices.slice(-period);
  const sma = relevantPrices.reduce((s, p) => s + p, 0) / period;

  const squaredDiffs = relevantPrices.map((p) => (p - sma) ** 2);
  const variance = squaredDiffs.reduce((s, d) => s + d, 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + stdDev * std,
    middle: sma,
    lower: sma - stdDev * std,
  };
}

export function computeAllIndicators(prices: number[]): TechnicalIndicators {
  const smaPeriods = [7, 25, 50, 100, 200];
  const emaPeriods = [7, 25, 50, 100, 200];

  const sma: Record<number, number> = {};
  for (const period of smaPeriods) {
    const values = computeSMA(prices, period);
    if (values.length > 0) {
      sma[period] = values[values.length - 1];
    }
  }

  const ema: Record<number, number> = {};
  for (const period of emaPeriods) {
    const values = computeEMA(prices, period);
    if (values.length > 0) {
      ema[period] = values[values.length - 1];
    }
  }

  const rsi = computeRSI(prices, 14) ?? 50;
  const macd = computeMACD(prices) ?? { macdLine: 0, signalLine: 0, histogram: 0 };
  const bollingerBands = computeBollingerBands(prices) ?? { upper: 0, middle: 0, lower: 0 };

  return { sma, ema, rsi, macd, bollingerBands };
}
