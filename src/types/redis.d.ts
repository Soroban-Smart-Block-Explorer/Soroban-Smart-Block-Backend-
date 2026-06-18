declare module 'redis' {
  export interface RedisClientType {
    connect(): Promise<void>;
    quit(): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, listener: (err: unknown) => void): void;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX: number }): Promise<void>;
    del(key: string): Promise<void>;
  }

  export function createClient(options: { url: string }): RedisClientType;
}
