/**
 * Soroban Feed SDK - TypeScript/JavaScript Client
 *
 * Real-time data streaming client for Soroban Smart Block Explorer
 */

export interface FeedConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface SubscriptionOptions {
  channelName: string;
  filters?: {
    pools?: string[];
    tokens?: string[];
    minAmount?: string;
    excludePools?: string[];
    contracts?: string[];
    accounts?: string[];
    eventTypes?: string[];
  };
  deliveryType: 'webhook' | 'websocket' | 'sse';
  deliveryConfig: {
    url?: string;
    headers?: Record<string, string>;
    batchSize?: number;
    maxInterval?: number;
    retryOnFailure?: boolean;
    maxRetries?: number;
  };
}

export interface BackfillOptions {
  channelName: string;
  startTime: string;
  endTime: string;
  format: 'jsonl' | 'csv' | 'parquet' | 'arrow' | 'json';
  filters?: any;
  compression?: 'none' | 'gzip' | 'brotli';
  callbackUrl?: string;
}

export class SorobanFeed {
  private config: FeedConfig;
  private baseUrl: string;
  private subscriptions = new Map<string, WebSocket | EventSource>();

  constructor(config: FeedConfig = {}) {
    this.config = {
      baseUrl: 'https://api.soroban.network/api/v1',
      timeout: 10000,
      ...config,
    };
    this.baseUrl = this.config.baseUrl!;
  }

  /**
   * Subscribe to a real-time feed channel
   */
  async subscribe(options: SubscriptionOptions): Promise<SorobanSubscription> {
    const response: any = await this.request('POST', '/feed/subscribe', options);
    const subscription = new SorobanSubscription(response.id, options, this);
    return subscription;
  }

  /**
   * List available channels
   */
  async getChannels() {
    return await this.request('GET', '/feed/channels');
  }

  /**
   * List your subscriptions
   */
  async getSubscriptions() {
    return await this.request('GET', '/feed/subscriptions');
  }

  /**
   * Request historical data backfill
   */
  async backfill(options: BackfillOptions) {
    return await this.request('POST', '/feed/backfill', options);
  }

  /**
   * Check backfill request status
   */
  async getBackfillStatus(requestId: string) {
    return await this.request('GET', `/feed/backfill/${requestId}`);
  }

  /**
   * Connect to WebSocket feed
   */
  connectWebSocket(channels: string[], filters?: any): SorobanWebSocket {
    const params = new URLSearchParams();
    params.set('channels', channels.join(','));
    if (filters) {
      params.set('filters', JSON.stringify(filters));
    }

    const wsUrl = this.baseUrl.replace('http', 'ws') + `/feed/ws?${params}`;
    const ws = new WebSocket(wsUrl);

    return new SorobanWebSocket(ws);
  }

  /**
   * Connect to Server-Sent Events feed
   */
  connectSSE(channels: string[], filters?: any): SorobanSSE {
    const params = new URLSearchParams();
    params.set('channels', channels.join(','));
    if (filters) {
      params.set('filters', JSON.stringify(filters));
    }

    const sseUrl = `${this.baseUrl}/feed/sse?${params}`;
    const eventSource = new EventSource(sseUrl);

    return new SorobanSSE(eventSource);
  }

  private async request(method: string, path: string, body?: any) {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error: any = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`API Error: ${response.status} - ${error.message}`);
    }

    return await response.json();
  }
}

export class SorobanSubscription {
  constructor(
    public readonly id: string,
    public readonly options: SubscriptionOptions,
    private feed: SorobanFeed,
  ) {}

  async getStatus() {
    return await this.feed['request']('GET', `/feed/subscriptions/${this.id}/status`);
  }

  async pause() {
    return await this.feed['request']('POST', `/feed/subscriptions/${this.id}/pause`);
  }

  async resume() {
    return await this.feed['request']('POST', `/feed/subscriptions/${this.id}/resume`);
  }

  async update(updates: Partial<SubscriptionOptions>) {
    return await this.feed['request']('PUT', `/feed/subscriptions/${this.id}`, updates);
  }

  async delete() {
    return await this.feed['request']('DELETE', `/feed/subscriptions/${this.id}`);
  }

  async sendTest() {
    return await this.feed['request']('POST', `/feed/subscriptions/${this.id}/test`);
  }
}

export class SorobanWebSocket {
  constructor(private ws: WebSocket) {}

  on(event: 'message' | 'error' | 'open' | 'close', callback: (...args: any[]) => void) {
    switch (event) {
      case 'message':
        this.ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            callback(data);
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
          }
        };
        break;
      case 'error':
        this.ws.onerror = callback as any;
        break;
      case 'open':
        this.ws.onopen = callback as any;
        break;
      case 'close':
        this.ws.onclose = callback as any;
        break;
    }
    return this;
  }

  send(message: any) {
    this.ws.send(JSON.stringify(message));
  }

  subscribe(channels: string[], filters?: any) {
    this.send({
      type: 'subscribe',
      channels,
      filters,
    });
  }

  unsubscribe(channels: string[]) {
    this.send({
      type: 'unsubscribe',
      channels,
    });
  }

  replay(lastSequence?: string) {
    this.send({
      type: 'replay',
      lastSequence,
    });
  }

  close() {
    this.ws.close();
  }
}

export class SorobanSSE {
  constructor(private eventSource: EventSource) {}

  on(event: 'message' | 'connected' | 'error' | 'heartbeat', callback: (data: any) => void) {
    this.eventSource.addEventListener(event, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        callback(data);
      } catch (err) {
        callback((e as MessageEvent).data);
      }
    });
    return this;
  }

  close() {
    this.eventSource.close();
  }
}

// Example usage:
/*
import { SorobanFeed } from '@soroban/feed-sdk';

const feed = new SorobanFeed({ apiKey: 'my-key' });

// Subscribe to trades
const sub = await feed.subscribe({
  channelName: 'trades',
  filters: { pools: ['C...'] },
  deliveryType: 'webhook',
  deliveryConfig: {
    url: 'https://api.mysystem.com/soroban-feed',
    headers: { Authorization: 'Bearer my-token' },
    batchSize: 100
  }
});

// WebSocket connection
const ws = feed.connectWebSocket(['trades'], { pools: ['C...'] });
ws.on('message', (trade) => console.log(trade));

// Server-Sent Events
const sse = feed.connectSSE(['events']);
sse.on('message', (event) => console.log(event));

// Backfill historical data
const backfill = await feed.backfill({
  channelName: 'trades',
  startTime: '2025-01-01T00:00:00Z',
  endTime: '2025-06-01T00:00:00Z',
  format: 'parquet'
});
*/

export default SorobanFeed;
