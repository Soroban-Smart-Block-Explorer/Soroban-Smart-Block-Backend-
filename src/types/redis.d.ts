declare module 'redis' {
  export interface RedisClientType {
    connect(): Promise<void>;
    quit(): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, listener: (err: unknown) => void): void;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX: number }): Promise<void>;
    del(key: string): Promise<void>;
    ping(): Promise<string>;
    subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
    unsubscribe(channel?: string): Promise<void>;
    publish(channel: string, message: string): Promise<number>;
    multi(): RedisMulti;
  }

  export interface RedisMulti {
    set(key: string, value: string, options?: { EX: number }): RedisMulti;
    del(key: string): RedisMulti;
    exec(): Promise<unknown[]>;
  }

  export interface RedisClientOptions {
    url?: string;
    socket?: Record<string, unknown>;
    username?: string;
    password?: string;
    database?: number;
  }

  export function createClient(options: RedisClientOptions): RedisClientType;
}
