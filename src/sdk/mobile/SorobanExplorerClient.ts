import {
  SorobanExplorerConfig,
  PaginatedResponse,
  Transaction,
  Contract,
  Event,
  Wallet,
  TokenPrice,
  GovernanceProposal,
  ComplianceEvent,
  Subscription,
  RetryConfig,
  CacheConfig,
} from './types';

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryOnStatuses: [429, 500, 502, 503, 504],
};

const DEFAULT_CACHE: CacheConfig = {
  ttlMs: 60000,
  maxEntries: 500,
  storage: 'memory',
};

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

export class SorobanExplorerClient {
  private config: SorobanExplorerConfig;
  private retryConfig: RetryConfig;
  private cacheConfig: CacheConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private offlineQueue: Array<{ method: string; path: string; body?: unknown }> = [];
  private isOnline: boolean = true;

  constructor(config: SorobanExplorerConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey,
      timeout: config.timeout ?? 10000,
      ...config,
    };
    this.retryConfig = { ...DEFAULT_RETRY, ...config.retryConfig };
    this.cacheConfig = { ...DEFAULT_CACHE, ...config.cacheConfig };
  }

  setOnlineStatus(online: boolean): void {
    this.isOnline = online;
    if (online) this.flushOfflineQueue();
  }

  async getTransactions(params?: {
    cursor?: number;
    page?: number;
    limit?: number;
    contract?: string;
    account?: string;
    status?: string;
  }): Promise<PaginatedResponse<Transaction>> {
    return this.request('GET', '/transactions', params);
  }

  async getTransaction(hash: string): Promise<Transaction> {
    return this.request('GET', `/transactions/${hash}`);
  }

  async getContracts(params?: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedResponse<Contract>> {
    return this.request('GET', '/contracts', params);
  }

  async getContract(address: string): Promise<Contract> {
    return this.request('GET', `/contracts/${address}`);
  }

  async getContractAbi(address: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/contracts/${address}/abi`);
  }

  async getContractEvents(
    address: string,
    params?: { cursor?: number; limit?: number; eventType?: string },
  ): Promise<PaginatedResponse<Event>> {
    return this.request('GET', `/contracts/${address}/events`, params);
  }

  async getWallet(address: string): Promise<Wallet> {
    return this.request('GET', `/wallets/${address}`);
  }

  async getWalletTransactions(
    address: string,
    params?: { cursor?: number; limit?: number },
  ): Promise<PaginatedResponse<Transaction>> {
    return this.request('GET', `/wallets/${address}/transactions`, params);
  }

  async getEvents(params?: {
    cursor?: number;
    limit?: number;
    contract?: string;
    eventType?: string;
  }): Promise<PaginatedResponse<Event>> {
    return this.request('GET', '/events', params);
  }

  async getTokenPrices(params?: { symbols?: string[] }): Promise<TokenPrice[]> {
    return this.request('GET', '/tokens/prices', params);
  }

  async getGovernanceProposals(params?: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<GovernanceProposal>> {
    return this.request('GET', '/governance/proposals', params);
  }

  async getComplianceEvents(params?: {
    severity?: string;
    address?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponse<ComplianceEvent>> {
    return this.request('GET', '/compliance/events', params);
  }

  async getSubscriptions(): Promise<Subscription[]> {
    return this.request('GET', '/subscriptions');
  }

  async createSubscription(sub: Omit<Subscription, 'id' | 'createdAt'>): Promise<Subscription> {
    return this.request('POST', '/subscriptions', sub);
  }

  async deleteSubscription(id: string): Promise<void> {
    return this.request('DELETE', `/subscriptions/${id}`);
  }

  private async request<T>(method: string, path: string, bodyOrParams?: unknown): Promise<T> {
    const cacheKey = `${method}:${path}:${JSON.stringify(bodyOrParams)}`;
    if (method === 'GET') {
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached as T;
    }

    if (!this.isOnline) {
      if (method !== 'GET') {
        this.offlineQueue.push({ method, path, body: bodyOrParams });
        throw new Error('Offline: request queued');
      }
      const cached = this.getFromCache(cacheKey);
      if (cached) return cached as T;
      throw new Error('Offline: no cached data available');
    }

    const url = new URL(`${this.config.baseUrl}/api/v1${path}`);
    if (method === 'GET' && bodyOrParams && typeof bodyOrParams === 'object') {
      for (const [key, value] of Object.entries(bodyOrParams as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const options: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (bodyOrParams && method !== 'GET') {
          options.body = JSON.stringify(bodyOrParams);
        }

        const response = await fetch(url.toString(), options);
        clearTimeout(timeoutId);

        if (!response.ok) {
          if (
            attempt < this.retryConfig.maxRetries &&
            this.retryConfig.retryOnStatuses.includes(response.status)
          ) {
            const delay = Math.min(
              this.retryConfig.baseDelayMs * Math.pow(2, attempt),
              this.retryConfig.maxDelayMs,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const errorBody = await response.json().catch(() => ({ message: response.statusText }));
          throw new Error(`API Error ${response.status}: ${errorBody.message}`);
        }

        const data = await response.json();
        if (method === 'GET') {
          this.setInCache(cacheKey, data);
        }
        return data as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryConfig.maxRetries) {
          const delay = Math.min(
            this.retryConfig.baseDelayMs * Math.pow(2, attempt),
            this.retryConfig.maxDelayMs,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error('Request failed');
  }

  private getFromCache(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setInCache(key: string, data: unknown): void {
    if (this.cache.size >= this.cacheConfig.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.cacheConfig.ttlMs,
    });
  }

  invalidateCache(pattern?: RegExp): void {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (pattern.test(key)) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
    }
  }

  getQueuedOperations(): Array<{ method: string; path: string; body?: unknown }> {
    return [...this.offlineQueue];
  }

  private async flushOfflineQueue(): Promise<void> {
    while (this.offlineQueue.length > 0) {
      const op = this.offlineQueue[0];
      try {
        await this.request(op.method, op.path, op.body);
        this.offlineQueue.shift();
      } catch {
        break;
      }
    }
  }
}
