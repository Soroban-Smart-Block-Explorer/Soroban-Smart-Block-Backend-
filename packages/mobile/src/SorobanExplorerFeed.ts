import { SorobanExplorerConfig } from './types';

interface FeedMessage {
  type: string;
  channel: string;
  sequence: string;
  data: unknown;
  timestamp: string;
}

export class SorobanExplorerFeed {
  private config: SorobanExplorerConfig;
  private useSSE: boolean;
  private ws: WebSocket | null = null;
  private eventSource: EventSource | null = null;
  private subscriptions: Map<
    string,
    { channel: string; filters?: Record<string, unknown>; callback: (msg: unknown) => void }
  > = new Map();
  private lastSequence: number = 0;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private isConnected: boolean = false;
  private eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private dedupSet: Set<string> = new Set();
  private dedupWindowMs: number = 5000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SorobanExplorerConfig, options?: { preferSSE?: boolean }) {
    this.config = config;
    this.useSSE = options?.preferSSE ?? false;
  }

  connect(channels: string[], filters?: Record<string, unknown>): void {
    if (this.useSSE) {
      this.connectSSE(channels, filters);
    } else {
      this.connectWebSocket(channels, filters);
    }
  }

  private connectWebSocket(channels: string[], filters?: Record<string, unknown>): void {
    const wsUrl = this.config.baseUrl.replace('http', 'ws') + '/api/v1/feed/ws';
    const params = new URLSearchParams();
    params.set('channels', channels.join(','));
    if (filters) params.set('filters', JSON.stringify(filters));
    this.connectWsWithRetry(`${wsUrl}?${params}`);
  }

  private connectWsWithRetry(url: string): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected', { timestamp: new Date().toISOString() });
      this.backfill();
      this.startHealthCheck();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this.emit('disconnected', { timestamp: new Date().toISOString() });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private connectSSE(channels: string[], filters?: Record<string, unknown>): void {
    const url = `${this.config.baseUrl}/api/v1/feed/sse`;
    const params = new URLSearchParams();
    params.set('channels', channels.join(','));
    if (filters) params.set('filters', JSON.stringify(filters));

    this.eventSource = new EventSource(`${url}?${params}`);

    this.eventSource.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected', { timestamp: new Date().toISOString() });
    };

    this.eventSource.addEventListener('message', (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch {
        // ignore parse errors
      }
    });

    this.eventSource.onerror = () => {
      this.isConnected = false;
      this.emit('disconnected', { timestamp: new Date().toISOString() });
      this.eventSource?.close();
      this.scheduleReconnect();
    };
  }

  private handleMessage(message: FeedMessage): void {
    const dedupKey = `${message.channel}:${message.sequence}`;
    if (this.dedupSet.has(dedupKey)) return;
    this.dedupSet.add(dedupKey);
    setTimeout(() => this.dedupSet.delete(dedupKey), this.dedupWindowMs);

    const seq = parseInt(message.sequence, 10);
    if (!isNaN(seq) && seq > this.lastSequence) {
      this.lastSequence = seq;
    }

    this.emit('message', message);
    this.emit(`channel:${message.channel}`, message.data);
  }

  private backfill(): void {
    if (this.lastSequence > 0 && this.ws) {
      this.ws.send(JSON.stringify({ type: 'replay', lastSequence: this.lastSequence }));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket([], {});
    }, delay);
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  subscribe(
    channel: string,
    callback: (data: unknown) => void,
    filters?: Record<string, unknown>,
  ): () => void {
    const id = `${channel}:${Date.now()}`;
    this.subscriptions.set(id, { channel, filters, callback });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', channels: [channel], filters }));
    }

    return () => {
      this.subscriptions.delete(id);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'unsubscribe', channels: [channel] }));
      }
    };
  }

  on(event: string, callback: (data: unknown) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, data: unknown): void {
    this.eventListeners.get(event)?.forEach((cb) => cb(data));
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.ws?.close();
    this.eventSource?.close();
    this.ws = null;
    this.eventSource = null;
    this.isConnected = false;
  }

  isConnectedStatus(): boolean {
    return this.isConnected;
  }
}
