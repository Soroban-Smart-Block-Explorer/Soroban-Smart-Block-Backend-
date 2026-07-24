import { TransactionFeatures, FraudSeverity } from '../types/fraud';
import { logger } from '../logger';

export interface InferenceResult {
  riskScore: number; // 0 to 100
  severity: FraudSeverity;
  shapValues: Record<string, number>;
  limeExplanation: string;
  inferenceTimeMs: number;
}

/**
 * 1. Time-series Anomaly Detector (LSTM-based Autoencoder mock)
 * Trained on normal transaction patterns, flags outliers.
 */
export class LstmAnomalyDetector {
  private normalThreshold = 0.65;
  private trainedMean = 0.2;
  private trainedStdDev = 0.15;

  async predict(features: TransactionFeatures): Promise<InferenceResult> {
    const startTime = Date.now();

    // Simulate LSTM autoencoder reconstruction error
    // Anomaly is high if there is huge gasPriceDeviation or sudden interTxArrivalTimeMs drops
    const normalizedGasDev = Math.min(2.0, Math.abs(features.gasPriceDeviation) / 5.0);
    const normalizedTimeDrop = features.interTxArrivalTimeMs < 500 ? 0.8 : 0.1;
    const reconstructionError = normalizedGasDev * 0.6 + normalizedTimeDrop * 0.4;

    const isAnomaly = reconstructionError > this.normalThreshold;
    const riskScore = Math.min(100, Math.round(reconstructionError * 100));

    const severity: FraudSeverity =
      riskScore >= 80 ? 'CRITICAL' : riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';

    // SHAP values calculation
    const shapValues = {
      gasPriceDeviation: normalizedGasDev * 0.6,
      interTxArrivalTimeMs: normalizedTimeDrop * 0.4,
      rollingTxCount: features.rollingTxCount > 50 ? 0.15 : 0.02,
    };

    const limeExplanation = `LSTM Autoencoder identified reconstruction error of ${reconstructionError.toFixed(3)} (threshold: ${this.normalThreshold}). Anomaly flagged due to abnormal gas price deviation (${features.gasPriceDeviation.toFixed(2)}) and inter-transaction arrival time (${features.interTxArrivalTimeMs}ms).`;

    const inferenceTimeMs = Date.now() - startTime;
    return { riskScore, severity, shapValues, limeExplanation, inferenceTimeMs };
  }

  train(historicalData: TransactionFeatures[]): void {
    if (historicalData.length === 0) return;
    logger.info(`Retraining LSTM Autoencoder on ${historicalData.length} records`);

    // Calculate normal thresholds from historical distribution
    const errors = historicalData.map((f) => {
      const normalizedGasDev = Math.min(2.0, Math.abs(f.gasPriceDeviation) / 5.0);
      const normalizedTimeDrop = f.interTxArrivalTimeMs < 500 ? 0.8 : 0.1;
      return normalizedGasDev * 0.6 + normalizedTimeDrop * 0.4;
    });

    const sum = errors.reduce((a, b) => a + b, 0);
    this.trainedMean = sum / errors.length;

    const sqDiffSum = errors.reduce((a, b) => a + Math.pow(b - this.trainedMean, 2), 0);
    this.trainedStdDev = Math.sqrt(sqDiffSum / errors.length) || 0.05;

    // Set anomaly threshold to mean + 3 * stdDev (99.7% confidence interval)
    this.normalThreshold = this.trainedMean + 3 * this.trainedStdDev;
    logger.info(
      `LSTM Autoencoder retrained. New anomaly threshold: ${this.normalThreshold.toFixed(4)}`,
    );
  }
}

/**
 * 2. Graph Neural Network (GNN - GraphSAGE / GAT mock)
 * Detects wash trading rings, Sybil clusters, and money laundering.
 */
export class GnnClusterDetector {
  async predict(features: TransactionFeatures): Promise<InferenceResult> {
    const startTime = Date.now();

    // High PageRank + low community size or extremely high centrality might signal wash trading hubs
    const centralityScore = Math.min(1.0, features.betweennessCentrality * 2.0);
    const pagerankScore = Math.min(1.0, features.pageRank * 5.0);

    // Sybil clusters usually have identical communityIds but high community activity
    const isSybilRisk = features.communityId > 0 && features.rollingTxCount > 80;
    const gnnOutput = centralityScore * 0.4 + pagerankScore * 0.3 + (isSybilRisk ? 0.3 : 0.0);

    const riskScore = Math.min(100, Math.round(gnnOutput * 100));

    const severity: FraudSeverity =
      riskScore >= 85 ? 'CRITICAL' : riskScore >= 65 ? 'HIGH' : riskScore >= 40 ? 'MEDIUM' : 'LOW';

    const shapValues = {
      betweennessCentrality: centralityScore * 0.4,
      pageRank: pagerankScore * 0.3,
      communitySybilRisk: isSybilRisk ? 0.3 : 0.0,
    };

    const limeExplanation = `GNN embedding layer flagged structural abnormality (betweenness centrality: ${features.betweennessCentrality.toFixed(3)}, pagerank: ${features.pageRank.toFixed(3)}). High density wallet community link (Community #${features.communityId}) suggests circular/Sybil ring pattern.`;

    const inferenceTimeMs = Date.now() - startTime;
    return { riskScore, severity, shapValues, limeExplanation, inferenceTimeMs };
  }

  train(historicalData: TransactionFeatures[]): void {
    logger.info(`Retraining GraphSAGE/GAT model on ${historicalData.length} nodes`);
    // Structural embeddings update logic
  }
}

/**
 * 3. Wash Trading Classifier (XGBoost/LightGBM mock)
 * Uses self-trading ratios, volume clustering, price deviations.
 */
export class XgboostWashTradingClassifier {
  async predict(features: TransactionFeatures): Promise<InferenceResult> {
    const startTime = Date.now();

    // Wash trading indicator features
    const hasVolumeClustering =
      features.rollingTxCount > 40 && Math.abs(features.priceCorrelation) > 0.4;
    const liquidityRatio = Math.min(1.0, features.dexLiquidityChange / 5.0);

    const xgboostProbability =
      (hasVolumeClustering ? 0.6 : 0.1) +
      liquidityRatio * 0.3 +
      (features.socialSentiment < -0.5 ? 0.1 : 0.0);

    const riskScore = Math.min(100, Math.round(xgboostProbability * 100));

    const severity: FraudSeverity =
      riskScore >= 75 ? 'CRITICAL' : riskScore >= 55 ? 'HIGH' : riskScore >= 35 ? 'MEDIUM' : 'LOW';

    const shapValues = {
      volumeClustering: hasVolumeClustering ? 0.6 : 0.1,
      dexLiquidityChange: liquidityRatio * 0.3,
      socialSentiment: features.socialSentiment < -0.5 ? 0.1 : 0.0,
    };

    const limeExplanation = `XGBoost model predicted wash trading risk based on volume clustering (${hasVolumeClustering ? 'suspicious' : 'normal'}), pool liquidity shift ratio (${liquidityRatio.toFixed(3)}), and sentiment shift (${features.socialSentiment.toFixed(2)}).`;

    const inferenceTimeMs = Date.now() - startTime;
    return { riskScore, severity, shapValues, limeExplanation, inferenceTimeMs };
  }

  train(historicalData: TransactionFeatures[]): void {
    logger.info(`Rebuilding XGBoost tree ensemble on ${historicalData.length} trading points`);
  }
}

/**
 * 4. Smart Contract Exploit Predictor (LLM-embedding mock)
 * Predicts reentrancy, flash loan attacks, oracle manipulation.
 */
export class ExploitPredictor {
  async predict(features: TransactionFeatures): Promise<InferenceResult> {
    const startTime = Date.now();

    // Exploit indicators
    const isFlashLoan =
      features.contractCallDepth > 4 && features.storageAccessPatterns.writes > 15;
    const isOracleManip =
      Math.abs(features.priceCorrelation) > 0.8 && features.dexLiquidityChange > 0.5;
    const isReentrancy =
      features.contractCallDepth > 6 && features.storageAccessPatterns.reads > 25;

    const exploitProbability =
      (isFlashLoan ? 0.5 : 0.0) + (isOracleManip ? 0.4 : 0.0) + (isReentrancy ? 0.7 : 0.1);

    const riskScore = Math.min(100, Math.round(exploitProbability * 100));

    const severity: FraudSeverity =
      riskScore >= 90 ? 'CRITICAL' : riskScore >= 70 ? 'HIGH' : riskScore >= 45 ? 'MEDIUM' : 'LOW';

    const shapValues = {
      flashLoanRisk: isFlashLoan ? 0.5 : 0.0,
      oracleManipulationRisk: isOracleManip ? 0.4 : 0.0,
      reentrancyRisk: isReentrancy ? 0.7 : 0.1,
    };

    const limeExplanation = `Contract Exploit Predictor identified high risk signature (reentrancy probability: ${isReentrancy ? 'HIGH' : 'LOW'}, flash loan risk: ${isFlashLoan ? 'HIGH' : 'LOW'}, oracle manipulation pattern: ${isOracleManip ? 'HIGH' : 'LOW'}). call depth: ${features.contractCallDepth}, writes: ${features.storageAccessPatterns.writes}.`;

    const inferenceTimeMs = Date.now() - startTime;
    return { riskScore, severity, shapValues, limeExplanation, inferenceTimeMs };
  }

  train(historicalData: TransactionFeatures[]): void {
    logger.info(`Retraining LLM exploit prediction adapter using ${historicalData.length} samples`);
  }
}
