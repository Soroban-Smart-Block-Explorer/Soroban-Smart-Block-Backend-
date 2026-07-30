import { Response } from 'express';
import WebSocket from 'ws';
import { SubscriptionManager } from './subscriptionManager';
import { deliveryService } from './deliveryService';
import { prismaRead as prisma } from '../db';
import { logger } from '../logger';

export interface StreamConnection {
  id: string;
  channels: string[];
  filters: any;
  send(event: string, data: any, sequence?: number): void;
  close(): void;
}

export class SSEStreamConnection implements StreamConnection {
  constructor(
    public id: string,
    private response: Response,
    public channels: string[],
    public filters: any,
  ) {}

  send(event: string, data: any, sequence?: number): void {
    if (sequence !== undefined) {
      this.response.write(`id: ${sequence}\n`);
    }
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    this.response.end();
  }
}

export class WebSocketStreamConnection implements StreamConnection {
  constructor(
    public id: string,
    public ws: WebSocket,
    public channels: string[],
    public filters: any,
  ) {}

  send(event: string, data: any, _sequence?: number): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: event, ...data }));
    }
  }

  close(): void {
    this.ws.close();
  }
}

export class StreamingServer {
  private connections = new Map<string, StreamConnection>();
  private subscriptionManager = new SubscriptionManager();

  constructor() {
    this.setupDeliveryHandlers();
  }

  addConnection(connection: StreamConnection): void {
    this.connections.set(connection.id, connection);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  getConnection(id: string): StreamConnection | undefined {
    return this.connections.get(id);
  }

  broadcast(channelName: string, message: any): void {
    const sequence = message.sequence?.toString();
    for (const connection of this.connections.values()) {
      try {
        if (!connection.channels.includes(channelName)) continue;
        if (!this.subscriptionManager.matchesFilters(message.data, connection.filters)) continue;

        connection.send(
          'message',
          {
            channel: channelName,
            sequence,
            data: message.data,
            timestamp: message.timestamp,
          },
          message.sequence,
        );
      } catch (error) {
        logger.error(`Failed to send to connection ${connection.id}:`, error);
        this.connections.delete(connection.id);
      }
    }
  }

  async replay(connection: StreamConnection, lastSequence: number): Promise<number> {
    const missedMessages = await prisma.feedMessage.findMany({
      where: {
        channelName: { in: connection.channels },
        sequence: { gt: lastSequence },
      },
      orderBy: { sequence: 'asc' },
      take: 100,
    });

    for (const msg of missedMessages) {
      if (this.subscriptionManager.matchesFilters(msg.data, connection.filters)) {
        connection.send(
          'message',
          {
            channel: msg.channelName,
            sequence: msg.sequence.toString(),
            data: msg.data,
            timestamp: msg.timestamp,
          },
          msg.sequence,
        );
      }
    }

    return missedMessages.length;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getActiveChannels(): string[] {
    const channels = new Set<string>();
    for (const conn of this.connections.values()) {
      for (const ch of conn.channels) {
        channels.add(ch);
      }
    }
    return Array.from(channels);
  }

  getChannelStats(): Map<string, number> {
    const stats = new Map<string, number>();
    for (const conn of this.connections.values()) {
      for (const ch of conn.channels) {
        stats.set(ch, (stats.get(ch) || 0) + 1);
      }
    }
    return stats;
  }

  shutdown(): void {
    for (const conn of this.connections.values()) {
      try {
        conn.close();
      } catch (error) {
        logger.error(`Error closing connection ${conn.id}:`, error);
      }
    }
    this.connections.clear();
  }

  private setupDeliveryHandlers(): void {
    for (const event of ['websocket-delivery', 'sse-delivery'] as const) {
      deliveryService.on(
        event,
        ({ connectionId, messages }: { connectionId: string; messages: any[] }) => {
          const connection = this.connections.get(connectionId);
          if (!connection) return;

          for (const message of messages) {
            connection.send(
              'message',
              {
                channel: message.channelName,
                sequence: message.sequence.toString(),
                data: message.data,
                timestamp: message.timestamp,
              },
              message.sequence,
            );
          }
        },
      );
    }
  }
}

export const streamingServer = new StreamingServer();
