export interface SorobanExplorerConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retryConfig?: RetryConfig;
  cacheConfig?: CacheConfig;
  offlineConfig?: OfflineConfig;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOnStatuses: number[];
}

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
  storage: 'memory' | 'sqlite' | 'asyncStorage';
}

export interface OfflineConfig {
  storageLimitMB: number;
  syncIntervalMs: number;
  batteryAware: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  cursor?: number;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CursorResponse<T> {
  data: T[];
  cursor: number | null;
  hasMore: boolean;
}

export interface Transaction {
  hash: string;
  ledgerSequence: number;
  ledgerCloseTime: string;
  sourceAccount: string;
  contractAddress?: string;
  functionName?: string;
  functionArgs?: any;
  status: string;
  humanReadable?: string;
  feeCharged?: string;
  failureReason?: string;
}

export interface Contract {
  address: string;
  name?: string;
  description?: string;
  isToken: boolean;
  tokenSymbol?: string;
  tokenName?: string;
  tokenDecimals?: number;
  isVerified: boolean;
  wasmHash?: string;
}

export interface Event {
  id: string;
  transactionHash: string;
  contractAddress: string;
  eventType: string;
  topicSymbol?: string;
  decoded?: any;
  ledgerSequence: number;
  ledgerCloseTime: string;
}

export interface Wallet {
  address: string;
  balance?: string;
  tokenBalances?: TokenBalance[];
  transactionCount?: number;
}

export interface TokenBalance {
  tokenAddress: string;
  symbol: string;
  balance: string;
  usdValue?: number;
}

export interface TokenPrice {
  address: string;
  symbol: string;
  priceUsd: number;
  change24h: number;
  volume24h: number;
  marketCap?: number;
}

export interface GovernanceProposal {
  id: string;
  contractAddress: string;
  title: string;
  description: string;
  status: 'pending' | 'active' | 'passed' | 'executed' | 'defeated';
  votesFor: number;
  votesAgainst: number;
  deadline: string;
}

export interface ComplianceEvent {
  id: string;
  type: 'freeze' | 'sanctions_match' | 'travel_rule' | 'screening_alert';
  address: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: string;
}

export interface Subscription {
  id: string;
  type: SubscriptionType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

export type SubscriptionType =
  | 'price_alert'
  | 'wallet_activity'
  | 'contract_event'
  | 'governance_milestone'
  | 'compliance_event'
  | 'gas_price_spike'
  | 'system_announcement';

export interface PushNotification {
  id: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  groupKey?: string;
  category?: string;
  deepLink?: string;
  timestamp: string;
  read: boolean;
}

export interface OfflineRecord<T> {
  id: string;
  data: T;
  lamport: number;
  replicaId: string;
  deleted: boolean;
  lastSyncedAt: string;
  lastAccessedAt: string;
}

export interface SyncDelta {
  created: OfflineRecord<unknown>[];
  updated: OfflineRecord<unknown>[];
  deleted: string[];
  lastSyncTimestamp: string;
}

export interface AuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface BiometricAuthResult {
  success: boolean;
  error?: string;
  biometricType?: 'faceid' | 'touchid' | 'fingerprint' | 'iris' | 'none';
}

export interface PushRegistration {
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId: string;
  subscriptions: SubscriptionType[];
  quietHours?: QuietHours;
}

export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
  emergencyOverride: boolean;
}

export interface NotificationDelivery {
  primary: 'fcm' | 'apns' | 'web_push';
  fallback: 'websocket' | 'polling';
}

export interface DeepLink {
  type: 'transaction' | 'wallet' | 'contract' | 'event' | 'proposal';
  id: string;
  raw: string;
}

export interface SyncStatus {
  lastSyncTimestamp: string | null;
  pendingUploads: number;
  pendingDownloads: number;
  storageUsedMB: number;
  isSyncing: boolean;
}

// ── On-device persistence (recent searches, watchlist, last-viewed) ───────────

/** Entity kinds the app can search for, watch, or open. */
export type EntityType = 'transaction' | 'contract' | 'wallet' | 'event' | 'token' | 'proposal';

/** A stable reference to an explorer entity. */
export interface EntityRef {
  type: EntityType;
  id: string;
}

/** A single entry in the persisted search history. */
export interface RecentSearch {
  query: string;
  searchedAt: string;
  resultCount?: number;
}

/** A watched entity plus its locally cached hydration summary. */
export interface WatchlistEntry extends EntityRef {
  label?: string;
  addedAt: string;
  summary?: HydrationEntitySummary;
}

/** The last entity the user opened, with its cached hydration summary. */
export interface LastViewedEntity extends EntityRef {
  label?: string;
  viewedAt: string;
  summary?: HydrationEntitySummary;
}

/**
 * Small server-rendered description of an entity, used to rehydrate the
 * recent-search / watchlist / last-viewed lists without fetching full records.
 */
export interface HydrationEntitySummary extends EntityRef {
  label: string;
  sublabel?: string;
  status?: string;
  updatedAt?: string;
}

/** Snapshot persisted on-device so the app is usable offline. */
export interface PersistedLocalState {
  version: number;
  recentSearches: RecentSearch[];
  watchlist: WatchlistEntry[];
  lastViewed: LastViewedEntity[];
}
