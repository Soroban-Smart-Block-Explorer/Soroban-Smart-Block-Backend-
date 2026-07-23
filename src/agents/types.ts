export type AgentStatus =
  | 'deployed'
  | 'validating'
  | 'active'
  | 'running'
  | 'paused'
  | 'terminated'
  | 'archived';
export type ExecutionStatus = 'running' | 'success' | 'failed';
export type ExecutionTrigger = 'scheduled' | 'manual' | 'event';

export interface CapabilityToken {
  capability: 'can_swap' | 'can_lend' | 'can_vote' | 'can_transfer' | 'can_deploy';
  agentId: string;
  maxAmount?: string;
  contracts?: string[];
  expiresAt?: number;
  nonce: string;
  signature: string;
}

export interface ResourceLimits {
  maxGasPerExecution: number;
  maxGasPerDay: number;
  maxExecutionsPerDay: number;
  maxStorageBytes: number;
  maxConcurrentCalls: number;
  maxDrawdownPercent: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxGasPerExecution: 1_000_000,
  maxGasPerDay: 10_000_000,
  maxExecutionsPerDay: 100,
  maxStorageBytes: 1_048_576,
  maxConcurrentCalls: 5,
  maxDrawdownPercent: 20.0,
};

export interface ExecutionStep {
  stepIndex: number;
  description: string;
  input: Record<string, unknown>;
  reasoning: string;
  output: Record<string, unknown>;
  gasUsed: number;
}

export interface ExecutionTrace {
  executionId: string;
  agentId: string;
  inputStateHash: string;
  steps: ExecutionStep[];
  outputAction: Record<string, unknown> | null;
  finalStateHash: string;
  signature: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  price?: string;
  configSchema: Record<string, unknown>;
  wasmBase64: string;
  abi: Record<string, unknown>;
  defaultPermissions: CapabilityToken[];
  defaultLimits: ResourceLimits;
}

export interface AgentMessagePayload {
  id: string;
  type:
    | 'request'
    | 'negotiate'
    | 'accept'
    | 'reject'
    | 'execute'
    | 'complete'
    | 'escalate'
    | 'rate';
  fromAgentId: string;
  toAgentId: string;
  subject: string;
  body: Record<string, unknown>;
  signature?: string;
  timestamp: string;
}

export interface AgentRegistrationEntry {
  agentId: string;
  capabilities: string[];
  pricePerCall?: string;
  pricePerMonth?: string;
  rating: number;
  totalJobsDone: number;
}

export interface DCAConfig {
  pair: { tokenA: string; tokenB: string };
  amountPerBuy: string;
  totalBuys: number;
  buysExecuted: number;
  frequencyMinutes: number;
  maxSlippagePercent: number;
  targetPrice?: string;
}

export interface GovernanceConfig {
  strategy: 'majority' | 'specific_delegates' | 'ai_analysis';
  delegateAddresses?: string[];
  minVotePower?: string;
  voteOnAllProposals: boolean;
  proposalFilter?: string;
}

export interface YieldOptimizerConfig {
  pools: string[];
  targetApy: number;
  rebalanceThresholdPercent: number;
  autoCompound: boolean;
}

export interface MevProtectorConfig {
  privateMempool: boolean;
  tipPercent: number;
  gasStrategy: 'aggressive' | 'standard' | 'conservative';
  maxWrapGas: number;
}

export interface StopLossConfig {
  positionContract: string;
  positionId: string;
  healthThreshold: number;
  swapTargetToken: string;
  maxSlippagePercent: number;
}

export interface LiquidationSniperConfig {
  targetPools: string[];
  minProfitPercent: number;
  maxGasForTx: number;
  maxConcurrentLiquidations: number;
}

export interface ComplianceConfig {
  riskThreshold: number;
  monitorAddresses: string[];
  freezeOnAlert: boolean;
  freezeStrategy: 'immediate' | 'threshold' | 'manual';
}
