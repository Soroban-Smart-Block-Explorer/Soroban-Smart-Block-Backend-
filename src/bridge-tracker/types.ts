export type BridgeProtocol = 'wormhole' | 'axelar' | 'allbridge' | 'stargate';

export type Chain =
  | 'ethereum'
  | 'solana'
  | 'cosmos'
  | 'bsc'
  | 'polygon'
  | 'avalanche'
  | 'arbitrum'
  | 'optimism';

export type BridgeStatus = 'pending' | 'detected' | 'bridging' | 'completed' | 'failed' | 'reorged';

export type AlertType =
  | 'large_transfer'
  | 'bridge_delay'
  | 'bridge_failure'
  | 'address_activity'
  | 'reorg_detected';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface BridgeEvent {
  transactionHash: string;
  sourceChain: Chain;
  destinationChain: Chain;
  asset: string;
  amount: string;
  sender: string;
  recipient: string;
  protocol: BridgeProtocol;
  blockNumber: number;
  timestamp?: Date;
  fee?: string;
}

export interface DetectionResult {
  detected: boolean;
  protocol?: BridgeProtocol;
  events: BridgeEvent[];
}

export interface ChainProviderConfig {
  rpcUrl: string;
  apiUrl: string;
  apiKey?: string;
  rateLimitPerMinute: number;
  confirmationBlocks: number;
  blockTimeSeconds: number;
}

export interface BridgeContractConfig {
  address: string;
  chain: Chain;
  protocol: BridgeProtocol;
  deployedAtBlock: number;
  eventSignatures: string[];
}

export interface FinalityInfo {
  status: BridgeStatus;
  confirmations: number;
  requiredConfirmations: number;
  sourceBlockNumber?: number;
  destinationBlockNumber?: number;
  sourceTxHash?: string;
  destinationTxHash?: string;
  estimatedArrivalAt?: Date;
  sourceTimestamp?: Date;
  destinationTimestamp?: Date;
  reorgDetected: boolean;
  blocksUntilFinality: number;
  progressPercent: number;
}

export interface VolumeStats {
  protocol: string;
  chain: string;
  asset: string;
  totalVolume: string;
  totalCount: number;
  averageAmount: string;
  fee: string;
}

export interface ActivityTrend {
  period: string;
  date: string;
  volume: string;
  count: number;
  protocol: string;
}

export interface FeeComparison {
  protocol: string;
  averageFee: string;
  medianFee: string;
  minFee: string;
  maxFee: string;
  totalFees: string;
  transactionCount: number;
}

export interface AlertConfig {
  largeTransferThresholdUsd: number;
  maxDelayMinutes: number;
  pollIntervalMs: number;
  monitorAddresses: boolean;
  monitorDelays: boolean;
  monitorLargeTransfers: boolean;
}

export interface MonitoredAddressEntry {
  id: string;
  address: string;
  chain: Chain;
  label?: string;
  minAlertUsd?: number;
  alertOnTx: boolean;
  alertOnBridging: boolean;
  active: boolean;
}

export interface BridgeAlertEntry {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  protocol?: string;
  chain?: string;
  address?: string;
  transactionHash?: string;
  asset?: string;
  amount?: string;
  message: string;
  data?: Record<string, unknown>;
  acknowledged: boolean;
  triggeredAt: Date;
}

export const PROTOCOL_NAMES: Record<BridgeProtocol, string> = {
  wormhole: 'Wormhole',
  axelar: 'Axelar',
  allbridge: 'Allbridge',
  stargate: 'Stargate',
};

export const CHAIN_NAMES: Record<Chain, string> = {
  ethereum: 'Ethereum',
  solana: 'Solana',
  cosmos: 'Cosmos',
  bsc: 'BSC',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
};
