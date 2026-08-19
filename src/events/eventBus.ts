/**
 * EventBus — cross-process pub/sub over Redis with an in-process fallback.
 *
 * Replaces the ad-hoc `EventEmitter`/DB-polling communication between services
 * with a single message-bus abstraction:
 *
 *   - Redis pub/sub when a Redis URL is configured (the default in production
 *     profiles), giving fan-out across every API/indexer instance.
 *   - An in-process `EventEmitter` fallback when Redis is unavailable or the
 *     URL is `memory://`, so single-process deployments and tests keep working.
 *
 * Message delivery is exactly-once per process: `publish()` emits to local
 * listeners synchronously and also publishes to Redis; the Redis echo is
 * suppressed via a bounded, TTL'd set of recently published message IDs.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from '../logger';

/** Minimal surface of the `redis` client used for pub/sub. */
interface RedisEventBusClient {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

const CHANNEL_PREFIX = 'events:';
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? config.cacheUrl ?? 'memory://';
const DEDUP_LIMIT = 2000;
const DEDUP_TTL_MS = 60_000;

export interface BusMessage<T = unknown> {
  id: string;
  event: string;
  payload: T;
  publishedAt: string;
}

type Listener<T = unknown> = (message: BusMessage<T>) => void | Promise<void>;

/** Canonical event names shared across the codebase. */
export const EventNames = {
  FeedMessage: 'feed.message',
  GraphqlTransaction: 'graphql.transaction',
  GraphqlEvent: 'graphql.event',
  GraphqlAlert: 'graphql.alert',
  WsEvent: 'ws.event',
  WsEmergency: 'ws.emergency',
} as const;

function isMemoryUrl(url: string): boolean {
  return url === '' || url.startsWith('memory://');
}

class EventBus {
  private local = new EventEmitter();
  private pubClient: RedisEventBusClient | null = null;
  private subClient: RedisEventBusClient | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private subscribedChannels = new Set<string>();
  private seen = new Map<string, number>(); // messageId -> expiry timestamp

  backendType(): 'redis' | 'memory' {
    return this.connected ? 'redis' : 'memory';
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (isMemoryUrl(EVENT_BUS_URL)) {
      logger.info('[event-bus] Using in-process backend (memory://)');
      return;
    }

    try {
      const { createClient } = await import('redis');
      const pub = createClient({ url: EVENT_BUS_URL }) as unknown as RedisEventBusClient;
      const sub = createClient({ url: EVENT_BUS_URL }) as unknown as RedisEventBusClient;

      pub.on('error', (err: unknown) => {
        logger.warn('[event-bus] Pub client error', { error: String(err) });
      });
      sub.on('error', (err: unknown) => {
        logger.warn('[event-bus] Sub client error', { error: String(err) });
      });

      await Promise.all([pub.connect(), sub.connect()]);
      this.pubClient = pub;
      this.subClient = sub;
      this.connected = true;

      // (Re)subscribe any channels registered before the connection was ready.
      for (const channel of this.subscribedChannels) {
        await this.subClient.subscribe(channel, (message: string) =>
          this.onRedisMessage(channel, message),
        );
      }

      logger.info('[event-bus] Connected to Redis pub/sub', { backend: 'redis' });
    } catch (err: unknown) {
      logger.warn('[event-bus] Redis unavailable; falling back to in-process backend', {
        error: String(err),
      });
      this.connected = false;
    }
  }

  async publish<T>(event: string, payload: T): Promise<BusMessage<T>> {
    const message: BusMessage<T> = {
      id: randomUUID(),
      event,
      payload,
      publishedAt: new Date().toISOString(),
    };

    this.remember(message.id);
    this.local.emit(event, message);

    if (this.connected && this.pubClient) {
      try {
        await this.pubClient.publish(CHANNEL_PREFIX + event, JSON.stringify(message));
      } catch (err: unknown) {
        logger.warn('[event-bus] Publish to Redis failed', { event, error: String(err) });
      }
    }

    return message;
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * The Redis channel is subscribed lazily (and re-subscribed on reconnect).
   */
  subscribe<T>(event: string, listener: Listener<T>): () => void {
    this.local.on(event, listener as (...args: unknown[]) => void);

    const channel = CHANNEL_PREFIX + event;
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      if (this.connected && this.subClient) {
        this.subClient
          .subscribe(channel, (message: string) => this.onRedisMessage(channel, message))
          .catch((err: unknown) =>
            logger.warn('[event-bus] Redis subscribe failed', { event, error: String(err) }),
          );
      }
    }

    return () => {
      this.local.off(event, listener as (...args: unknown[]) => void);
    };
  }

  private onRedisMessage(channel: string, raw: string): void {
    let message: BusMessage;
    try {
      message = JSON.parse(raw) as BusMessage;
    } catch {
      return;
    }
    if (this.isSeen(message.id)) return;
    this.remember(message.id);
    this.local.emit(message.event, message);
  }

  private remember(id: string): void {
    const now = Date.now();
    this.seen.set(id, now + DEDUP_TTL_MS);

    if (this.seen.size > DEDUP_LIMIT) {
      for (const [key, expiry] of this.seen) {
        if (expiry <= now) this.seen.delete(key);
      }
      while (this.seen.size > DEDUP_LIMIT) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
    }
  }

  private isSeen(id: string): boolean {
    const expiry = this.seen.get(id);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.subClient) {
      try {
        await this.subClient.unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        await this.subClient.quit();
      } catch {
        await this.subClient.disconnect();
      }
      this.subClient = null;
    }
    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch {
        await this.pubClient.disconnect();
      }
      this.pubClient = null;
    }
    this.connected = false;
    this.connecting = null;
    this.subscribedChannels.clear();
    this.seen.clear();
    this.local.removeAllListeners();
  }
}

export const eventBus = new EventBus();
