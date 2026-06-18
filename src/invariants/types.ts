/**
 * Smart Contract Invariant Tester - Type Definitions
 * Comprehensive formal verification and runtime monitoring platform
 */

// ============================================================================
// INVARIANT CATEGORIES & TYPES
// ============================================================================

export enum InvariantCategory {
  STATE = 'state',
  ALGEBRAIC = 'algebraic',
  TEMPORAL = 'temporal',
  COMPOSABILITY = 'composability',
  ACCESS_CONTROL = 'access_control',
  ECONOMIC = 'economic',
}

export enum InvariantSeverity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  INFO = 'info',
}

export enum CheckFrequency {
  ALWAYS = 'always',
  AFTER_WRITE = 'after_write',
  PERIODIC = 'periodic',
  ON_DEMAND = 'on_demand',
}

// ============================================================================
// INVARIANT DEFINITIONS
// ============================================================================

export interface InvariantDefinitionInput {
  name: string;
  description?: string;
  category: InvariantCategory;
  contractAddress?: string;
  expression: string;
  expressionLanguage?: string;
  severity?: InvariantSeverity;
  checkFrequency?: CheckFrequency;
  gasLimit?: bigint;
  timeoutMs?: number;
  isActive?: boolean;
  createdBy?: string;
}

export interface InvariantDefinitionDTO {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  contractAddress?: string | null;
  expression: string;
  expressionLanguage: string;
  severity: string;
  checkFrequency: string;
  gasLimit?: bigint | null;
  timeoutMs: number;
  isActive: boolean;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// EXPRESSION PARSING & EVALUATION
// ============================================================================

export type PrimitiveValue = string | number | boolean | bigint | null;
export type JsonValue = PrimitiveValue | JsonValue[] | { [key: string]: JsonValue };

export interface ExpressionContext {
  variables: Map<string, JsonValue>;
  functions: Map<string, (...args: JsonValue[]) => JsonValue>;
  state: Record<string, JsonValue>;
}

export enum TokenType {
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  IDENTIFIER = 'IDENTIFIER',
  OPERATOR = 'OPERATOR',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  COMMA = 'COMMA',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string | number;
  line: number;
  column: number;
}

export interface ASTNode {
  type: string;
  [key: string]: any;
}

export interface BinaryOpNode extends ASTNode {
  type: 'BinaryOp';
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryOpNode extends ASTNode {
  type: 'UnaryOp';
  operator: string;
  operand: ASTNode;
}

export interface LiteralNode extends ASTNode {
  type: 'Literal';
  value: PrimitiveValue;
}

export interface IdentifierNode extends ASTNode {
  type: 'Identifier';
  name: string;
}

export interface FunctionCallNode extends ASTNode {
  type: 'FunctionCall';
  name: string;
  arguments: ASTNode[];
}

// ============================================================================
// CHECK RESULTS & VIOLATIONS
// ============================================================================

export interface InvariantCheckResultInput {
  invariantId: string;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  result: boolean;
  executionTimeMs?: number;
  gasUsed?: string;
  stateSnapshot?: JsonValue;
  violationDetail?: JsonValue;
  errorMessage?: string;
}

export interface InvariantCheckResultDTO {
  id: bigint;
  invariantId: string;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  result: boolean;
  executionTimeMs?: number | null;
  gasUsed?: string | null;
  stateSnapshot?: JsonValue;
  violationDetail?: JsonValue;
  errorMessage?: string | null;
  createdAt: Date;
}

export enum ViolationStatus {
  OPEN = 'open',
  INVESTIGATING = 'investigating',
  CONFIRMED = 'confirmed',
  FALSE_POSITIVE = 'false_positive',
  FIXED = 'fixed',
}

export interface InvariantViolationInput {
  invariantId: string;
  checkResultId?: bigint;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  severity: InvariantSeverity;
  status?: ViolationStatus;
  assignedTo?: string;
  stateBefore?: JsonValue;
  stateAfter?: JsonValue;
  revertSim?: JsonValue;
  notes?: string;
}

export interface InvariantViolationDTO {
  id: bigint;
  invariantId: string;
  checkResultId?: bigint | null;
  txHash: string;
  blockNumber: bigint;
  timestamp: Date;
  severity: string;
  status: string;
  assignedTo?: string | null;
  stateBefore?: JsonValue;
  stateAfter?: JsonValue;
  revertSim?: JsonValue;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// MONITORING & REAL-TIME
// ============================================================================

export interface MonitoringConfigInput {
  contractAddress: string;
  invariantIds?: string[];
  checkMode?: 'all' | 'sample' | 'critical';
  sampleRate?: number;
  maxGasPerCheck?: string;
  isActive?: boolean;
}

export interface MonitoringConfigDTO {
  id: string;
  contractAddress: string;
  invariantIds: string[];
  checkMode: string;
  sampleRate: number;
  maxGasPerCheck?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoringStatsDTO {
  id: bigint;
  contractAddress: string;
  totalChecks: bigint;
  passedChecks: bigint;
  failedChecks: bigint;
  avgCheckTimeMs?: string | null;
  totalGasUsed?: string | null;
  lastCheckAt?: Date | null;
  lastViolationAt?: Date | null;
  updatedAt: Date;
}

// ============================================================================
// INVARIANT MINING
// ============================================================================

export enum MiningType {
  STATIC = 'static',
  DYNAMIC = 'dynamic',
  DAIKON = 'daikon',
  ML_BASED = 'ml_based',
  TEMPLATE = 'template',
}

export interface MiningRunInput {
  contractAddress: string;
  miningType: MiningType;
  txRangeStart?: bigint;
  txRangeEnd?: bigint;
}

export interface InvariantCandidateDTO {
  id: bigint;
  miningRunId: string;
  expression: string;
  confidence?: string | null;
  supportCount?: number | null;
  counterexampleCount?: number | null;
  isConfirmed: boolean;
  confirmedAt?: Date | null;
}

// ============================================================================
// FUZZ TESTING
// ============================================================================

export interface FuzzCampaignInput {
  contractAddress: string;
  name?: string;
  invariantIds?: string[];
  totalIterations: number;
  config?: Record<string, any>;
}

export interface FuzzCampaignDTO {
  id: string;
  contractAddress: string;
  name?: string | null;
  invariantIds: string[];
  totalIterations?: number | null;
  iterationsExecuted: number;
  coveragePercentage?: string | null;
  violationsFound: number;
  status: string;
  config?: Record<string, any>;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
}

// ============================================================================
// SYMBOLIC EXECUTION
// ============================================================================

export interface SymbolicExecutionResultDTO {
  id: string;
  contractAddress: string;
  functionName?: string | null;
  pathsExplored?: number | null;
  assertionViolations?: JsonValue;
  reentrancyRisks?: JsonValue;
  arithmeticIssues?: JsonValue;
  generatedTestCases?: JsonValue;
  status: string;
  startedAt: Date;
  completedAt?: Date | null;
}

// ============================================================================
// COMPLIANCE
// ============================================================================

export enum ComplianceFrameworkType {
  SOC2 = 'soc2',
  MICA = 'mica',
  SEC = 'sec',
  CUSTOM = 'custom',
}

export interface ComplianceFrameworkInput {
  name: string;
  description?: string;
  version?: string;
  rules: Record<string, any>;
}

export interface ComplianceAuditInput {
  contractAddress: string;
  frameworkId: string;
  totalRules: number;
}

export interface ComplianceAuditDTO {
  id: string;
  contractAddress: string;
  frameworkId?: string | null;
  status: string;
  passedRules: number;
  failedRules: number;
  totalRules: number;
  report?: JsonValue;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
}

// ============================================================================
// STANDARD INVARIANTS
// ============================================================================

export enum ContractType {
  TOKEN = 'token',
  AMM = 'amm',
  LENDING = 'lending',
  STAKING = 'staking',
}

export interface StandardInvariantDTO {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  contractType: string;
  expressionTemplate: string;
  parameters?: JsonValue;
  severity: string;
  isEnabledByDefault: boolean;
  createdAt: Date;
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface StatsResponse {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  failureRate: number;
  avgCheckTime: number;
  successRate: number;
}

// ============================================================================
// ALERT & NOTIFICATION
// ============================================================================

export interface AlertRuleInput {
  invariantId: string;
  minSeverity?: InvariantSeverity;
  cooldownSeconds?: number;
  escalateAfterCount?: number;
  escalateWindowMinutes?: number;
  notificationChannels?: Record<string, any>;
}

export interface AlertRuleDTO {
  id: string;
  invariantId: string;
  minSeverity: string;
  cooldownSeconds: number;
  escalateAfterCount: number;
  escalateWindowMinutes: number;
  notificationChannels?: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// EXPRESSION FUNCTION REGISTRY
// ============================================================================

export interface ExpressionFunctionDTO {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  signature: string;
  isPure: boolean;
  isAggregate: boolean;
  createdAt: Date;
}

// ============================================================================
// CONTRACT STATE SNAPSHOT
// ============================================================================

export interface ContractStateSnapshot {
  contractAddress: string;
  blockNumber: bigint;
  timestamp: Date;
  state: Record<string, JsonValue>;
  storageFrontier?: JsonValue;
}

// ============================================================================
// CROSS-CONTRACT ANALYSIS
// ============================================================================

export interface CrossContractAnalysisDTO {
  id: string;
  sourceContract: string;
  targetContract: string;
  interactionType?: string | null;
  composabilityIssues?: JsonValue;
  stateInconsistencies?: JsonValue;
  reentrancyRisks?: JsonValue;
  confidenceScore?: string | null;
  analyzedAt: Date;
}

// ============================================================================
// REPAIR SUGGESTIONS
// ============================================================================

export interface RepairSuggestionDTO {
  id: string;
  violationId: bigint;
  contractAddress: string;
  originalExpression: string;
  suggestedPatch: string;
  patchType?: string | null;
  confidenceScore?: string | null;
  verificationStatus?: string | null;
  createdAt: Date;
}
