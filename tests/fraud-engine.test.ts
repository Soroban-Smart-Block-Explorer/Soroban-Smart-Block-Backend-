import { describe, it, expect, vi } from 'vitest';
import { getFraudFeatureStore } from '../src/services/fraudFeatureStore';
import { getMlopsService } from '../src/services/mlops';
import { getFraudAlertSystem } from '../src/services/fraudAlertSystem';
import {
  LstmAnomalyDetector,
  GnnClusterDetector,
  XgboostWashTradingClassifier,
  ExploitPredictor,
} from '../src/predictive/fraud-models';

// Mock DB clients so tests run locally without Postgres connection
vi.mock('../src/db', () => {
  return {
    prismaRead: {
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          hash: 'tx_abc123',
          sourceAccount: 'GDET_TEST_ACCOUNT',
          contractAddress: 'CCONTRACT_TEST_ADDRESS',
          ledgerSequence: 1000,
          ledgerCloseTime: new Date(),
          feeCharged: '150',
          sorobanResources: { footprint: { readOnly: ['k1', 'k2'], readWrite: ['k3'] } },
          events: [{}, {}],
        }),
        findMany: vi.fn().mockResolvedValue([
          { feeCharged: '120', ledgerSequence: 998, ledgerCloseTime: new Date(Date.now() - 5000) },
          { feeCharged: '130', ledgerSequence: 999, ledgerCloseTime: new Date(Date.now() - 1000) },
        ]),
        count: vi.fn().mockResolvedValue(2),
      },
      event: {
        count: vi.fn().mockResolvedValue(5),
      },
      callGraphVertex: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ depth: 3, preStateReads: ['r1'], postStateWrites: ['w1'] }]),
      },
      tokenPrice: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ tokenAddress: 'CCONTRACT_TEST_ADDRESS', priceChange24h: 2.5 }),
      },
      dexPool: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            token0Address: 'CCONTRACT_TEST_ADDRESS',
            totalValueAtRisk: 1000000,
          }),
      },
      modelRegistryEntry: {
        count: vi.fn().mockResolvedValue(4),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'm-1',
            name: 'LSTM-Autoencoder-Anomaly',
            type: 'LSTM',
            version: '1.0.0',
            status: 'ACTIVE',
            metrics: { accuracy: 0.95 },
          },
          {
            id: 'm-2',
            name: 'GraphSAGE-Sybil-GNN',
            type: 'GNN',
            version: '1.0.0',
            status: 'SHADOW',
            metrics: { accuracy: 0.93 },
          },
        ]),
        findUnique: vi
          .fn()
          .mockResolvedValue({
            id: 'm-1',
            name: 'LSTM-Autoencoder-Anomaly',
            type: 'LSTM',
            version: '1.0.0',
            status: 'ACTIVE',
            metrics: { accuracy: 0.95 },
          }),
      },
      featureStoreEntry: {
        findMany: vi.fn().mockResolvedValue(
          Array(50).fill({
            entityId: 'entity1',
            features: {
              gasPriceDeviation: 0.1,
              contractCallDepth: 1,
              pageRank: 0.15,
              storageAccessPatterns: { reads: 1, writes: 0 },
            },
          }),
        ),
      },
      indexerState: {
        findUnique: vi.fn().mockResolvedValue({ lastLedger: 1005 }),
      },
      fraudAlert: {
        count: vi.fn().mockResolvedValue(1),
      },
    },
    prismaWrite: {
      fraudAlert: {
        create: vi
          .fn()
          .mockImplementation((args) => Promise.resolve({ id: 'alert_id_123', ...args.data })),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      featureStoreEntry: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      modelRegistryEntry: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
      },
      modelDriftMetrics: {
        create: vi.fn().mockResolvedValue({}),
      },
      fraudRetrainingLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      frozenLedgerKey: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      emergencyState: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      incidentReport: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

describe('Fraud Feature Store', () => {
  it('should return default features for missing entities', async () => {
    const store = getFraudFeatureStore();
    const defaultFeatures = store.getDefaultFeatures();
    expect(defaultFeatures.gasPriceDeviation).toBe(0);
    expect(defaultFeatures.contractCallDepth).toBe(1);
    expect(defaultFeatures.storageAccessPatterns.reads).toBe(1);
  });

  it('should extract features correctly using db info', async () => {
    const store = getFraudFeatureStore();
    const features = await store.extractFeaturesForEntity('tx_abc123');
    expect(features.gasPriceDeviation).toBeDefined();
    expect(features.contractCallDepth).toBe(3); // from mock callGraphVertex
    expect(features.storageAccessPatterns.reads).toBe(2); // from callGraphVertex (fallback)
    expect(features.eventEmitFrequency).toBe(5); // from mock event count
  });

  it('should retrieve online features caching correctly', async () => {
    const store = getFraudFeatureStore();
    const f1 = await store.getOnlineFeatures('tx_abc123');
    const f2 = await store.getOnlineFeatures('tx_abc123');
    expect(f1).toEqual(f2);
  });
});

describe('Fraud Model Zoo', () => {
  const mockFeatures = {
    gasPriceDeviation: 4.5, // abnormally high
    contractCallDepth: 7,
    storageAccessPatterns: { reads: 30, writes: 20 },
    eventEmitFrequency: 50,
    rollingTxCount: 95,
    averageTxAmount: 50.0,
    interTxArrivalTimeMs: 150, // very low
    ledgerDelta: 1,
    pageRank: 0.85,
    betweennessCentrality: 0.9,
    communityId: 4,
    priceCorrelation: -0.9,
    socialSentiment: -0.85,
    dexLiquidityChange: 4.2,
  };

  it('LSTM Anomaly Detector detects gas price and inter-arrival time anomalies', async () => {
    const detector = new LstmAnomalyDetector();
    const result = await detector.predict(mockFeatures);
    expect(result.riskScore).toBeGreaterThan(60);
    expect(result.severity).toBeDefined();
    expect(result.limeExplanation).toContain('LSTM');
    expect(result.shapValues.gasPriceDeviation).toBeGreaterThan(0);
  });

  it('GNN Cluster Detector flags network/Sybil anomalies', async () => {
    const detector = new GnnClusterDetector();
    const result = await detector.predict(mockFeatures);
    expect(result.riskScore).toBeGreaterThan(70);
    expect(result.shapValues.betweennessCentrality).toBeGreaterThan(0);
  });

  it('XGBoost Wash Trading Classifier flags wash trading indicators', async () => {
    const detector = new XgboostWashTradingClassifier();
    const result = await detector.predict(mockFeatures);
    expect(result.riskScore).toBeGreaterThan(60);
    expect(result.shapValues.volumeClustering).toBeGreaterThan(0);
  });

  it('Exploit Predictor flags reentrancy and flash loan exploits', async () => {
    const detector = new ExploitPredictor();
    const result = await detector.predict(mockFeatures);
    expect(result.riskScore).toBeGreaterThan(80);
    expect(result.severity).toBe('CRITICAL');
  });
});

describe('MLOps Infrastructure Service', () => {
  it('scores transactions using active + shadow model scoring', async () => {
    const mlops = getMlopsService();
    const features = getFraudFeatureStore().getDefaultFeatures();
    const result = await mlops.scoreTransaction(features);
    expect(result.activeScore).toBeDefined();
    expect(result.activeSeverity).toBeDefined();
    expect(result.shadowScores['GraphSAGE-Sybil-GNN']).toBeDefined();
  });

  it('monitors model drift', async () => {
    const mlops = getMlopsService();
    const report = await mlops.monitorFeatureDrift();
    expect(report.length).toBeGreaterThan(0);
    expect(report[0].featureDrifts).toBeDefined();
  });
});

describe('Fraud Alert & Response System Orchestration', () => {
  it('runs the full end-to-end analysis and action pipeline', async () => {
    const system = getFraudAlertSystem();
    const alert = await system.analyzeAndAct('CCONTRACT_TEST_ADDRESS', 'SMART_CONTRACT_EXPLOIT');
    expect(alert.id).toBe('alert_id_123');
    expect(alert.riskScore).toBeDefined();
    expect(alert.severity).toBeDefined();
    expect(alert.alertType).toBe('SMART_CONTRACT_EXPLOIT');
  });
});
