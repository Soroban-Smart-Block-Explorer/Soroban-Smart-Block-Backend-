import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { URLSearchParams } from 'url';
import { ChannelManager } from '../feed/channelManager';
import { SubscriptionManager } from '../feed/subscriptionManager';
import { deliveryService } from '../feed/deliveryService';

interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  channels: string[];
  filters: any;
  lastSequence?: bigint;
}

export class FeedWebSocketServer {
  private wss: WebSocket.Server;
  private connections = new Map<string, WebSocketConnection>();
  private subscriptionManager = new SubscriptionManager();
  private heartbeatInterval!: NodeJS.Timeout;

  constructor(server: any) {
    this.wss = new WebSocket.Server({
      server,
      path: '/api/v1/feed/ws',
    });

    this.setupWebSocketHandlers();
    this.startHeartbeat();
    this.setupDeliveryHandler();
  }

  private setupWebSocketHandlers() {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const connectionId = this.generateConnectionId();
      const url = new URL(request.url!, `http://${request.headers.host}`);

      // Parse query parameters
      const channels = url.searchParams.get('channels')?.split(',') || [];
      const filtersParam = url.searchParams.get('filters');
      let filters = {};

      if (filtersParam) {
        try {
          filters = JSON.parse(filtersParam);
        } catch (error) {
          ws.close(1003, 'Invalid filters JSON');
          return;
        }
      }

      // Validate channels
      for (const channel of channels) {
        if (!ChannelManager.isValidChannel(channel)) {
          ws.close(1003, `Invalid channel: ${channel}`);
          return;
        }
      }

      const connection: WebSocketConnection = {
        id: connectionId,
        ws,
        channels,
        filters,
      };

      this.connections.set(connectionId, connection);

      console.log(`WebSocket connected: ${connectionId}, channels: ${channels.join(', ')}`);

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'welcome',
          connectionId,
          channels,
          timestamp: new Date().toISOString(),
        }),
      );

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(connectionId, data);
      });

      ws.on('close', () => {
        this.connections.delete(connectionId);
        console.log(`WebSocket disconnected: ${connectionId}`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for ${connectionId}:`, error);
        this.connections.delete(connectionId);
      });

      // Handle ping/pong for keepalive
      ws.on('pong', () => {
        (connection.ws as any).isAlive = true;
      });
    });
  }

  private handleMessage(connectionId: string, data: WebSocket.RawData) {
    try {
      const message = JSON.parse(data.toString());
      const connection = this.connections.get(connectionId);

      if (!connection) return;

      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(connection, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(connection, message);
          break;
        case 'replay':
          this.handleReplay(connection, message);
          break;
        case 'ping':
          connection.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
      }
    } catch (error) {
      console.error(`Failed to handle WebSocket message from ${connectionId}:`, error);
    }
  }

  private handleSubscribe(connection: WebSocketConnection, message: any) {
    const { channels, filters } = message;

    if (channels) {
      for (const channel of channels) {
        if (ChannelManager.isValidChannel(channel) && !connection.channels.includes(channel)) {
          connection.channels.push(channel);
        }
      }
    }

    if (filters) {
      connection.filters = { ...connection.filters, ...filters };
    }

    connection.ws.send(
      JSON.stringify({
        type: 'subscribed',
        channels: connection.channels,
        filters: connection.filters,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private handleUnsubscribe(connection: WebSocketConnection, message: any) {
    const { channels } = message;

    if (channels) {
      connection.channels = connection.channels.filter((ch) => !channels.includes(ch));
    }

    connection.ws.send(
      JSON.stringify({
        type: 'unsubscribed',
        channels: connection.channels,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private async handleReplay(connection: WebSocketConnection, message: any) {
    const { lastSequence } = message;

    if (lastSequence) {
      try {
        // Fetch missed messages since lastSequence
        const missedMessages = await this.getMissedMessages(
          connection.channels,
          BigInt(lastSequence),
        );

        for (const msg of missedMessages) {
          if (this.subscriptionManager.matchesFilters(msg.data, connection.filters)) {
            connection.ws.send(
              JSON.stringify({
                type: 'message',
                channel: msg.channelName,
                sequence: msg.sequence.toString(),
                data: msg.data,
                timestamp: msg.timestamp,
              }),
            );
          }
        }

        connection.ws.send(
          JSON.stringify({
            type: 'replay_complete',
            replayedCount: missedMessages.length,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (error) {
        connection.ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Failed to replay messages',
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  private async getMissedMessages(channels: string[], lastSequence: bigint) {
    const { prisma } = await import('../db');
    return await prisma.feedMessage.findMany({
      where: {
        channelName: { in: channels },
        sequence: { gt: lastSequence },
      },
      orderBy: { sequence: 'asc' },
      take: 100, // Limit to prevent overwhelming
    });
  }

  private setupDeliveryHandler() {
    deliveryService.on('websocket-delivery', ({ connectionId, messages }) => {
      const connection = this.connections.get(connectionId);
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      for (const message of messages) {
        connection.ws.send(
          JSON.stringify({
            type: 'message',
            channel: message.channelName,
            sequence: message.sequence.toString(),
            data: message.data,
            timestamp: message.timestamp,
          }),
        );
      }
    });
  }

  broadcast(channelName: string, message: any) {
    for (const connection of this.connections.values()) {
      if (
        connection.channels.includes(channelName) &&
        connection.ws.readyState === WebSocket.OPEN &&
        this.subscriptionManager.matchesFilters(message.data, connection.filters)
      ) {
        connection.ws.send(
          JSON.stringify({
            type: 'message',
            channel: channelName,
            sequence: message.sequence?.toString(),
            data: message.data,
            timestamp: message.timestamp,
          }),
        );
      }
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: any) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 30 seconds
  }

  private generateConnectionId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getActiveChannels(): string[] {
    const channels = new Set<string>();
    for (const connection of this.connections.values()) {
      for (const channel of connection.channels) {
        channels.add(channel);
      }
    }
    return Array.from(channels);
  }

  shutdown() {
    clearInterval(this.heartbeatInterval);
    this.wss.close();

    for (const connection of this.connections.values()) {
      connection.ws.close();
    }

    this.connections.clear();
  }
}

// Extend WebSocket type to include isAlive property
declare module 'ws' {
  interface WebSocket {
    isAlive?: boolean;
  }
}
