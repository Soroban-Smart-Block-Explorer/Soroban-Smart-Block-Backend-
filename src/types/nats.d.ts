/**
 * Ambient declaration for the optional NATS client. The `nats` package is not
 * a hard dependency (NATS JetStream is an optional distributed-processing
 * transport); this keeps typechecking green without pulling the runtime dep
 * into every install. Mirror of src/types/redis.d.ts pattern.
 */
declare module 'nats' {
  export interface NatsConnection {
    jetstream(): JetStreamClient;
    close(): Promise<void>;
    drain(): Promise<void>;
    closed(): Promise<void>;
    isClosed(): boolean;
    info: unknown;
  }

  export interface JetStreamClient {
    publish(subject: string, data?: Uint8Array, options?: object): Promise<unknown>;
    subscribe(subject: string, options?: object): unknown;
    deleteStream(name: string): Promise<void>;
  }

  export interface JetStreamOptions {
    name: string;
    subjects: string[];
    max_age?: number;
    max_msg_size?: number;
    duplicate_window?: number;
    max_timeout?: number;
  }

  export function connect(options: {
    servers: string[];
    timeout?: number;
    reconnect?: boolean;
    maxReconnectAttempts?: number;
  }): Promise<NatsConnection>;

  export function parseDuration(input: string): number;

  export function jetstream(conn: NatsConnection, opts?: object): JetStreamClient;
  export function StringCodec(): {
    encode(input: string): Uint8Array;
    decode(data: Uint8Array): string;
  };
}
