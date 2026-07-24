import { Logger } from '../logger';
import { db } from '../db';
import * as tf from '@tensorflow/tfjs-node';

/**
 * Predictive Ledger Activity Model
 * LSTM-based time series forecasting for:
 * - Predicting transaction throughput spikes
 * - Enabling pre-scaling of worker pools
 * - Guiding graceful degradation decisions
 */

const logger = new Logger('PredictiveModel');

export interface ActivityPrediction {
  timestamp: number;
  horizon: number; // minutes ahead
  predictedThroughput: number; // tx/s
  confidenceInterval: [number, number]; // [lower, upper]
  confidence: number; // 0-1
  scalingAction?: 'scale_up' | 'scale_down' | 'maintain';
  requiredWorkers?: number;
}

export interface PredictionFeatures {
  hourOfDay: number; // 0-23
  dayOfWeek: number; // 0-6
  recentThroughput: number; // tx/s in last 10 min
  queueDepthTrend: number; // slope of queue depth
  contractDeploymentCount: number; // new contracts deployed
  protocolUpgradeFlag: boolean;
  externalSignalScore: number; // 0-1, from Twitter/exchange signals
  holidayFlag: boolean;
}

export interface ModelConfig {
  sequenceLength: number; // how many time steps to look back
  predictionHorizons: number[]; // [5, 15, 30, 60] minutes
  lstmUnits: number;
  dropoutRate: number;
  batchSize: number;
  epochs: number;
}

const DEFAULT_CONFIG: ModelConfig = {
  sequenceLength: 168, // 7 days of hourly data
  predictionHorizons: [5, 15, 30, 60],
  lstmUnits: 128,
  dropoutRate: 0.2,
  batchSize: 32,
  epochs: 100,
};

// Mock data for demonstration (in production, use real training data)
const MOCK_THROUGHPUT_PATTERNS = {
  timeOfDay: {
    // Peak hours: 14:00-18:00 UTC (high Asian/Europe overlap)
    14: 1.2,
    15: 1.3,
    16: 1.2,
    17: 1.1,
    // Low: 04:00-08:00 UTC
    4: 0.7,
    5: 0.6,
    6: 0.7,
    7: 0.8,
  },
  dayOfWeek: {
    // Higher mid-week, lower on weekends
    0: 0.9, // Monday
    1: 1.0, // Tuesday
    2: 1.0, // Wednesday
    3: 1.0, // Thursday
    4: 0.95, // Friday
    5: 0.8, // Saturday
    6: 0.75, // Sunday
  },
};

export class PredictiveModelService {
  private model: tf.LayersModel | null = null;
  private config: ModelConfig;
  private lastTrainingTime: number = 0;
  private recentPredictions: Map<number, ActivityPrediction> = new Map();
  private trainingData: number[][] = [];

  constructor(config: Partial<ModelConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize model from saved weights or create new
   */
  async initialize(): Promise<void> {
    try {
      // Try to load pretrained model from storage
      const modelPath = 'indexeddb://soroban-activity-predictor';
      try {
        this.model = await tf.loadLayersModel(modelPath);
        logger.info('Loaded pretrained model');
      } catch {
        logger.info('No pretrained model found, creating new model');
        await this.createNewModel();
      }
    } catch (error) {
      logger.error('Failed to initialize model', { error });
      throw error;
    }
  }

  /**
   * Create and compile new LSTM model
   */
  private async createNewModel(): Promise<void> {
    if (!this.model) {
      this.model = tf.sequential({
        layers: [
          // Input layer
          tf.layers.lstm({
            units: this.config.lstmUnits,
            returnSequences: true,
            inputShape: [this.config.sequenceLength, 8], // 8 features
          }),
          tf.layers.dropout({ rate: this.config.dropoutRate }),

          // Second LSTM layer
          tf.layers.lstm({
            units: this.config.lstmUnits,
            returnSequences: false,
          }),
          tf.layers.dropout({ rate: this.config.dropoutRate }),

          // Dense layers
          tf.layers.dense({ units: 64, activation: 'relu' }),
          tf.layers.dense({ units: 32, activation: 'relu' }),

          // Output: 4 predictions (5, 15, 30, 60 min horizons)
          tf.layers.dense({ units: this.config.predictionHorizons.length, activation: 'linear' }),
        ],
      });

      this.model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanAbsoluteError',
        metrics: ['mae'],
      });

      logger.info('Created new LSTM model', { config: this.config });
    }
  }

  /**
   * Extract features for prediction
   */
  extractFeatures(timestamp: number = Date.now()): PredictionFeatures {
    const date = new Date(timestamp);
    const hourOfDay = date.getUTCHours();
    const dayOfWeek = date.getUTCDay();

    // In real implementation, fetch from metrics/signals
    const recentThroughput = 200; // mock: 200 tx/s
    const queueDepthTrend = 0.5; // mock: slight upward trend
    const contractDeploymentCount = 3; // mock: 3 new contracts
    const protocolUpgradeFlag = false; // check configuration
    const externalSignalScore = this.getExternalSignalScore(); // Twitter/exchange API
    const holidayFlag = this.isHolidayOrEvent(); // check calendar

    return {
      hourOfDay,
      dayOfWeek,
      recentThroughput,
      queueDepthTrend,
      contractDeploymentCount,
      protocolUpgradeFlag,
      externalSignalScore,
      holidayFlag: holidayFlag ? 1 : 0,
    };
  }

  /**
   * Predict throughput for specified horizon
   */
  async predict(horizon: number = 5): Promise<ActivityPrediction> {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    try {
      const features = this.extractFeatures();
      const featureArray = this.featuresToArray(features);

      // Mock prediction for demonstration
      const baseThroughput = this.getBaselineThroughput(features);
      const predicted = await this.mockPredict(baseThroughput, features, horizon);

      const prediction: ActivityPrediction = {
        timestamp: Date.now(),
        horizon,
        predictedThroughput: predicted.mean,
        confidenceInterval: [predicted.lower, predicted.upper],
        confidence: predicted.confidence,
        scalingAction: this.determineScalingAction(predicted.mean),
        requiredWorkers: Math.ceil(predicted.mean / 250), // ~250 tx/s per worker
      };

      // Cache prediction
      this.recentPredictions.set(horizon, prediction);

      // Persist for monitoring
      await this.persistPrediction(prediction);

      return prediction;
    } catch (error) {
      logger.error('Prediction failed', { error, horizon });
      throw error;
    }
  }

  /**
   * Train model with historical data
   */
  async train(historicalData: number[][]): Promise<{ loss: number; mae: number }> {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    try {
      this.trainingData = historicalData;

      // Prepare sequences for LSTM
      const { X, y } = this.prepareSequences(historicalData);

      // Convert to tensors
      const xTensor = tf.tensor3d(X);
      const yTensor = tf.tensor2d(y);

      // Train
      const history = await this.model.fit(xTensor, yTensor, {
        epochs: this.config.epochs,
        batchSize: this.config.batchSize,
        shuffle: true,
        verboseFrequency: 10,
      });

      xTensor.dispose();
      yTensor.dispose();

      const loss = (history.history.loss as number[]).pop() || 0;
      const mae = (history.history.mae as number[]).pop() || 0;

      this.lastTrainingTime = Date.now();

      // Save model
      await this.saveModel();

      logger.info('Model training completed', { loss, mae });

      return { loss, mae };
    } catch (error) {
      logger.error('Training failed', { error });
      throw error;
    }
  }

  /**
   * Get RMSE and accuracy metrics
   */
  async getModelMetrics(): Promise<{
    rmse: number;
    accuracy: number;
    lastTraining: number;
    predictionsCount: number;
  }> {
    try {
      // Calculate RMSE from recent predictions vs actual
      const result = await db.query(
        `
        SELECT 
          SQRT(AVG(POWER(COALESCE(actual_throughput, 0) - predicted_throughput, 2))) as rmse,
          AVG(CASE 
            WHEN ABS(actual_throughput - predicted_throughput) < (predicted_throughput * 0.2) 
            THEN 1 ELSE 0 
          END) as accuracy,
          COUNT(*) as total
        FROM predictions
        WHERE created_at > NOW() - INTERVAL '7 days'
        `,
      );

      const metrics = result.rows[0] || {};

      return {
        rmse: parseFloat(metrics.rmse || 0),
        accuracy: parseFloat(metrics.accuracy || 0),
        lastTraining: this.lastTrainingTime,
        predictionsCount: parseInt(metrics.total || 0),
      };
    } catch (error) {
      logger.warn('Failed to calculate model metrics', { error });
      return { rmse: 0, accuracy: 0, lastTraining: this.lastTrainingTime, predictionsCount: 0 };
    }
  }

  /**
   * Helper: Convert features to array for model
   */
  private featuresToArray(features: PredictionFeatures): number[] {
    return [
      features.hourOfDay / 24,
      features.dayOfWeek / 7,
      features.recentThroughput / 1000, // normalize
      features.queueDepthTrend,
      features.contractDeploymentCount / 100,
      features.protocolUpgradeFlag ? 1 : 0,
      features.externalSignalScore,
      features.holidayFlag,
    ];
  }

  /**
   * Helper: Get baseline throughput based on time-of-day and day-of-week
   */
  private getBaselineThroughput(features: PredictionFeatures): number {
    const timeMultiplier =
      MOCK_THROUGHPUT_PATTERNS.timeOfDay[
        features.hourOfDay as keyof typeof MOCK_THROUGHPUT_PATTERNS.timeOfDay
      ] || 1.0;
    const dayMultiplier =
      MOCK_THROUGHPUT_PATTERNS.dayOfWeek[
        features.dayOfWeek as keyof typeof MOCK_THROUGHPUT_PATTERNS.dayOfWeek
      ] || 1.0;

    const baseThroughput = 200; // average baseline: 200 tx/s
    return baseThroughput * timeMultiplier * dayMultiplier;
  }

  /**
   * Helper: Mock prediction (replace with actual LSTM inference in production)
   */
  private async mockPredict(baseThroughput: number, features: PredictionFeatures, horizon: number) {
    // Mock: add some noise and horizon-based multiplier
    const horizonMultiplier = 1 + horizon * 0.02; // slight increase over longer horizons
    const noise = (Math.random() - 0.5) * baseThroughput * 0.2; // ±10% noise
    const predicted = baseThroughput * horizonMultiplier + noise;

    // Add external signal boost
    const signalBoost = features.externalSignalScore * 100; // up to +100 tx/s

    return {
      mean: Math.max(50, predicted + signalBoost),
      lower: Math.max(50, predicted + signalBoost - 50),
      upper: predicted + signalBoost + 50,
      confidence: 0.85 + Math.random() * 0.1, // 85-95% confidence
    };
  }

  /**
   * Helper: Determine scaling action
   */
  private determineScalingAction(
    predictedThroughput: number,
  ): 'scale_up' | 'scale_down' | 'maintain' {
    const currentThroughput = 200; // mock
    const threshold = 300; // scale up if predicted > 300 tx/s

    if (predictedThroughput > threshold) return 'scale_up';
    if (predictedThroughput < 100) return 'scale_down';
    return 'maintain';
  }

  /**
   * Helper: Get external signal score (0-1)
   */
  private getExternalSignalScore(): number {
    // In production: call Twitter API, CoinGecko, etc.
    return Math.random() * 0.3; // mock: 0-30% boost
  }

  /**
   * Helper: Check if date is holiday or major event
   */
  private isHolidayOrEvent(): boolean {
    // In production: check calendar of crypto events
    return false; // mock
  }

  /**
   * Helper: Prepare sequences for LSTM training
   */
  private prepareSequences(data: number[][]): { X: number[][][]; y: number[][] } {
    const X: number[][][] = [];
    const y: number[][] = [];

    for (let i = this.config.sequenceLength; i < data.length - 4; i++) {
      // Input: last N timesteps
      X.push(data.slice(i - this.config.sequenceLength, i));

      // Output: next 4 predictions (5, 15, 30, 60 min ahead)
      y.push([data[i + 0][0], data[i + 1][0], data[i + 2][0], data[i + 3][0]]);
    }

    return { X, y };
  }

  /**
   * Save trained model to storage
   */
  private async saveModel(): Promise<void> {
    if (!this.model) return;

    try {
      const modelPath = 'indexeddb://soroban-activity-predictor';
      await this.model.save(modelPath);
      logger.info('Model saved');
    } catch (error) {
      logger.error('Failed to save model', { error });
    }
  }

  /**
   * Persist prediction to database
   */
  private async persistPrediction(prediction: ActivityPrediction): Promise<void> {
    try {
      await db.query(
        `
        INSERT INTO predictions 
          (model_id, timestamp, horizon_minutes, predicted_throughput, confidence, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        `,
        [
          1,
          new Date(prediction.timestamp),
          prediction.horizon,
          prediction.predictedThroughput,
          prediction.confidence,
        ],
      );
    } catch (error) {
      logger.warn('Failed to persist prediction', { error });
    }
  }

  /**
   * Get recent predictions
   */
  getRecentPredictions(): ActivityPrediction[] {
    return Array.from(this.recentPredictions.values());
  }
}

// Singleton instance
let instance: PredictiveModelService | null = null;

export async function getPredictiveModelService(): Promise<PredictiveModelService> {
  if (!instance) {
    instance = new PredictiveModelService();
    await instance.initialize();
  }
  return instance;
}
