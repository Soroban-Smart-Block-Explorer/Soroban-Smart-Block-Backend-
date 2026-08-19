export interface TransactionFeatures {
  // Transaction-level
  gasPriceDeviation: number; // deviation from 100-tx rolling avg
  contractCallDepth: number; // cross-contract call depth
  storageAccessPatterns: {
    reads: number;
    writes: number;
  };
  eventEmitFrequency: number; // events emitted by this contract in current window

  // Temporal
  rollingTxCount: number; // last 100 txs from this account
  averageTxAmount: number; // rolling avg amount
  interTxArrivalTimeMs: number; // time since last tx
  ledgerDelta: number; // ledger diff since last tx

  // Graph
  pageRank: number;
  betweennessCentrality: number;
  communityId: number;

  // Fusion
  priceCorrelation: number; // correlation with token price movement
  socialSentiment: number; // sentiment index (-1.0 to 1.0)
  dexLiquidityChange: number; // liquidity delta in DEX pools
}

export type FraudModelType = 'LSTM' | 'GNN' | 'XGBoost' | 'LLM_Embedding';

export type ModelDeploymentStatus = 'ACTIVE' | 'SHADOW' | 'CANDIDATE';

export interface FraudModelMetadata {
  id: string;
  name: string;
  type: FraudModelType;
  version: string;
  status: ModelDeploymentStatus;
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1Score: number;
    inferenceTimeMs: number;
  };
  parameters: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export type FraudSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FraudAlert {
  id: string;
  transactionHash: string;
  targetAddress: string; // wallet or contract address
  riskScore: number; // 0 to 100
  severity: FraudSeverity;
  alertType: 'MEV' | 'WASH_TRADING' | 'SYBIL' | 'SMART_CONTRACT_EXPLOIT';
  explanation: {
    baseReason: string;
    shapValues: Record<string, number>;
    limeExplanation: string;
  };
  mitigationApplied: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DriftMetrics {
  featureName: string;
  psi: number; // Population Stability Index
  ksStatistic: number; // Kolmogorov-Smirnov statistic
  driftDetected: boolean;
}

export interface ModelDriftReport {
  modelId: string;
  timestamp: Date;
  featureDrifts: DriftMetrics[];
  predictionDrift: number; // drift in output distribution
  driftThresholdExceeded: boolean;
}
