import { featureStore } from '../indexer/feature-store';
import { config } from '../config';
import { logger } from '../logger';
import { EnsembleForecaster } from './ensemble';
import { IForecastingModel, ArimaSimulation, XgboostSimulation, LstmSimulation } from './models';
import { LinearTrendModel, SeasonalMeanModel } from './production-models';
import { prismaWrite as prisma } from '../db';

export interface TrainingMetrics {
  modelName: string;
  trainingDataSize: number;
  trainingDuration: number;
  validationMse: number;
  lastTrainedAt: Date;
}

export interface TrainingConfig {
  minDataPoints: number;
  maxDataPoints: number;
  validationSplit: number;
  retrainThreshold: number; // days since last training
  metrics: string[];
}

export class ModelTrainingService {
  private static instance: ModelTrainingService | null = null;
  private trainingInProgress = false;
  private lastTrainingTime: Date | null = null;
  private trainingMetrics: TrainingMetrics[] = [];

  private readonly trainingConfig: TrainingConfig = {
    minDataPoints: 30,
    maxDataPoints: 365,
    validationSplit: 0.2,
    retrainThreshold: 7, // retrain every 7 days
    metrics: ['tx_volume', 'tx_volume_7d_ma', 'account_creation_rate', 'contract_invocation_rate'],
  };

  public static getInstance(): ModelTrainingService {
    if (!ModelTrainingService.instance) {
      ModelTrainingService.instance = new ModelTrainingService();
    }
    return ModelTrainingService.instance;
  }

  /**
   * Initialize and train all models with available historical data
   */
  public async initializeModels(): Promise<EnsembleForecaster> {
    if (this.trainingInProgress) {
      throw new Error('Training already in progress');
    }

    this.trainingInProgress = true;
    const startTime = Date.now();

    try {
      // Get available metrics from the database
      const availableMetrics = await this.getAvailableMetrics();

      // Create model instances based on config mode
      const models = await this.createModelInstances();

      // Train models with historical data
      await this.trainModels(models, availableMetrics);

      // Create and return ensemble forecaster
      const forecaster = new EnsembleForecaster(models);

      this.lastTrainingTime = new Date();
      const trainingDuration = Date.now() - startTime;

      logger.info(`Model training completed in ${trainingDuration}ms`);
      logger.info(`Trained ${models.length} models on ${availableMetrics.length} metrics`);

      return forecaster;
    } finally {
      this.trainingInProgress = false;
    }
  }

  /**
   * Check if models need retraining based on configuration
   */
  public needsRetraining(): boolean {
    if (!this.lastTrainingTime) return true;

    const daysSinceTraining =
      (Date.now() - this.lastTrainingTime.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceTraining >= this.trainingConfig.retrainThreshold;
  }

  /**
   * Get available metrics from the database
   */
  private async getAvailableMetrics(): Promise<string[]> {
    const featureDefs = await prisma.featureDefinition.findMany({
      select: { name: true },
    });

    const availableMetrics = featureDefs.map((def) => def.name);

    // Fallback to configured metrics if no data is available
    if (availableMetrics.length === 0) {
      logger.warn('No metrics found in database, using configured fallback metrics');
      return this.trainingConfig.metrics;
    }

    return availableMetrics;
  }

  /**
   * Create model instances based on configuration mode
   */
  private async createModelInstances(): Promise<IForecastingModel[]> {
    const mode = config.forecastMode;
    const seed = config.forecastSeed;

    if (mode === 'production') {
      return [new LinearTrendModel(), new SeasonalMeanModel()];
    } else {
      // Demo mode - but still train with real data instead of mocks
      return [new ArimaSimulation(seed), new XgboostSimulation(seed), new LstmSimulation(seed)];
    }
  }

  /**
   * Train all models with historical data from available metrics
   */
  private async trainModels(models: IForecastingModel[], metrics: string[]): Promise<void> {
    for (const model of models) {
      const modelStartTime = Date.now();

      try {
        // Get primary training data (use the first available metric or tx_volume as default)
        const primaryMetric = metrics.includes('tx_volume') ? 'tx_volume' : metrics[0];
        const trainingData = await this.prepareTrainingData(primaryMetric);

        if (trainingData.length < this.trainingConfig.minDataPoints) {
          logger.warn(
            `Insufficient data for ${model.name}: ${trainingData.length} points, minimum required: ${this.trainingConfig.minDataPoints}`,
          );
          continue;
        }

        // Prepare additional features if available
        const features = await this.prepareFeatures(metrics.slice(1, 5)); // Use up to 4 additional features

        // Split data for validation
        const { trainData, validationData } = this.splitTrainingData(trainingData);

        // Train the model
        model.train(trainData, features);

        // Calculate validation metrics
        const validationMse = this.calculateValidationMse(model, validationData);

        // Store training metrics
        const trainingDuration = Date.now() - modelStartTime;
        this.trainingMetrics.push({
          modelName: model.name,
          trainingDataSize: trainData.length,
          trainingDuration,
          validationMse,
          lastTrainedAt: new Date(),
        });

        logger.info(
          `Trained ${model.name}: ${trainData.length} data points, MSE: ${validationMse.toFixed(4)}`,
        );
      } catch (error) {
        logger.error(`Failed to train model ${model.name}:`, { error });
        // Continue training other models even if one fails
      }
    }
  }

  /**
   * Prepare training data for a specific metric
   */
  private async prepareTrainingData(metric: string): Promise<number[]> {
    try {
      // Get historical data from feature store
      const data = await featureStore.getHistoricalData(metric, this.trainingConfig.maxDataPoints);

      if (data.length === 0) {
        logger.warn(`No historical data found for metric: ${metric}`);
        return [];
      }

      // Basic data preprocessing
      return this.preprocessData(data);
    } catch (error) {
      logger.error(`Error preparing training data for ${metric}:`, { error });
      return [];
    }
  }

  /**
   * Prepare feature data for additional model inputs
   */
  private async prepareFeatures(featureMetrics: string[]): Promise<Record<string, number[]>> {
    const features: Record<string, number[]> = {};

    for (const metric of featureMetrics) {
      try {
        const data = await featureStore.getHistoricalData(
          metric,
          this.trainingConfig.maxDataPoints,
        );
        if (data.length > 0) {
          features[metric] = this.preprocessData(data);
        }
      } catch (error) {
        logger.warn(`Failed to prepare feature ${metric}:`, { error });
      }
    }

    return features;
  }

  /**
   * Basic data preprocessing: remove outliers and handle missing values
   */
  private preprocessData(data: number[]): number[] {
    if (data.length === 0) return data;

    // Calculate quartiles for outlier detection
    const sorted = [...data].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    // Remove extreme outliers and replace with median
    const median = sorted[Math.floor(sorted.length * 0.5)];

    return data.map((value) => {
      if (value < lowerBound || value > upperBound) {
        return median;
      }
      return value;
    });
  }

  /**
   * Split data into training and validation sets
   */
  private splitTrainingData(data: number[]): { trainData: number[]; validationData: number[] } {
    const splitIndex = Math.floor(data.length * (1 - this.trainingConfig.validationSplit));

    return {
      trainData: data.slice(0, splitIndex),
      validationData: data.slice(splitIndex),
    };
  }

  /**
   * Calculate Mean Squared Error for validation
   */
  private calculateValidationMse(model: IForecastingModel, validationData: number[]): number {
    if (validationData.length === 0) return 0;

    try {
      // Use the first part of validation data to predict the rest
      const inputSize = Math.min(7, Math.floor(validationData.length / 2));
      const inputData = validationData.slice(0, inputSize);
      const expectedData = validationData.slice(inputSize);

      if (expectedData.length === 0) return 0;

      // Make predictions
      const predictions = model.predict(expectedData.length, inputData);

      // Calculate MSE
      let sumSquaredError = 0;
      for (let i = 0; i < Math.min(predictions.length, expectedData.length); i++) {
        const error = predictions[i].predictedValue - expectedData[i];
        sumSquaredError += error * error;
      }

      return sumSquaredError / Math.min(predictions.length, expectedData.length);
    } catch (error) {
      logger.warn(`Error calculating validation MSE for ${model.name}:`, { error });
      return 0;
    }
  }

  /**
   * Get training metrics for monitoring
   */
  public getTrainingMetrics(): TrainingMetrics[] {
    return [...this.trainingMetrics];
  }

  /**
   * Get training status
   */
  public getTrainingStatus(): { inProgress: boolean; lastTrainedAt: Date | null } {
    return {
      inProgress: this.trainingInProgress,
      lastTrainedAt: this.lastTrainingTime,
    };
  }

  /**
   * Force retrain all models
   */
  public async forceRetrain(): Promise<EnsembleForecaster> {
    this.lastTrainingTime = null; // Reset to force retraining
    return this.initializeModels();
  }
}

export const modelTrainingService = ModelTrainingService.getInstance();
