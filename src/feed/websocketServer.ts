import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { ChannelManager } from '../feed/channelManager';
import { streamingServer, WebSocketStreamConnection } from './streamingServer';
import { logger } from '../logger';

const MAX_CONNECTIONS_PER_IP = parseInt(process.env.FEED_WS_MAX_CONNECTIONS_PER_IP ?? '5', 10);
const MAX_TOTAL_CONNECTIONS = parseInt(process.env.FEED_WS_MAX_TOTAL_CONNECTIONS ?? '100', 10);

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export class FeedWebSocketServer {
  private wss: WebSocket.Server;
  private heartbeatInterval!: NodeJS.Timeout;
  private ipConnectionCounts = new Map<string, number>();
  private totalConnections = 0;

  constructor(server: any) {
    this.wss = new WebSocket.Server({
      server,
      path: '/api/v1/feed/ws',
    });

    this.setupWebSocketHandlers();
    this.startHeartbeat();
  }

  private setupWebSocketHandlers() {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const ip = getClientIp(request);

      if (this.totalConnections >= MAX_TOTAL_CONNECTIONS) {
        ws.close(4003, 'Server at capacity: too many connections');
        return;
      }

      if ((this.ipConnectionCounts.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
        ws.close(4004, `Rate limit exceeded: max ${MAX_CONNECTIONS_PER_IP} connections per IP`);
        return;
      }

      this.totalConnections++;
      this.ipConnectionCounts.set(ip, (this.ipConnectionCounts.get(ip) ?? 0) + 1);
      let releasedCount = false;
      const releaseCount = () => {
        if (releasedCount) return;
        releasedCount = true;
        this.totalConnections--;
        const count = this.ipConnectionCounts.get(ip) ?? 1;
        if (count <= 1) this.ipConnectionCounts.delete(ip);
        else this.ipConnectionCounts.set(ip, count - 1);
      };

      const connectionId = this.generateConnectionId();
      const url = new URL(request.url!, `http://${request.headers.host}`);

      const channels = url.searchParams.get('channels')?.split(',') || [];
      const filtersParam = url.searchParams.get('filters');
      let filters = {};

      if (filtersParam) {
        try {
          filters = JSON.parse(filtersParam);
        } catch {
          ws.close(1003, 'Invalid filters JSON');
          releaseCount();
          return;
        }
      }

      for (const channel of channels) {
        if (!ChannelManager.isValidChannel(channel)) {
          ws.close(1003, `Invalid channel: ${channel}`);
          releaseCount();
          return;
        }
      }

      const connection = new WebSocketStreamConnection(connectionId, ws, channels, filters);
      streamingServer.addConnection(connection);

      logger.info(`WebSocket connected: ${connectionId}, channels: ${channels.join(', ')}`);

      ws.send(
        JSON.stringify({
          type: 'welcome',
          connectionId,
          channels,
          timestamp: new Date().toISOString(),
        }),
      );

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(connection, data);
      });

      ws.on('close', () => {
        streamingServer.removeConnection(connectionId);
        releaseCount();
        logger.info(`WebSocket disconnected: ${connectionId}`);
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error for ${connectionId}:`, error);
        streamingServer.removeConnection(connectionId);
        releaseCount();
      });

      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });
    });
  }

  private handleMessage(connection: WebSocketStreamConnection, data: WebSocket.RawData) {
    try {
      const message = JSON.parse(data.toString());
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
          connection.send('pong', { timestamp: new Date().toISOString() });
          break;
      }
    } catch (error) {
      logger.error(`Failed to handle WebSocket message from ${connection.id}:`, error);
    }
  }

  private handleSubscribe(connection: WebSocketStreamConnection, message: any) {
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

    connection.send('subscribed', {
      channels: connection.channels,
      filters: connection.filters,
      timestamp: new Date().toISOString(),
    });
  }

  private handleUnsubscribe(connection: WebSocketStreamConnection, message: any) {
    const { channels } = message;

    if (channels) {
      connection.channels = connection.channels.filter((ch) => !channels.includes(ch));
    }

    connection.send('unsubscribed', {
      channels: connection.channels,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleReplay(connection: WebSocketStreamConnection, message: any) {
    const { lastSequence } = message;

    if (lastSequence === undefined) return;

    try {
      const count = await streamingServer.replay(connection, lastSequence);
      connection.send('replay_complete', {
        replayedCount: count,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to replay messages for ${connection.id}:`, error);
      connection.send('error', {
        message: 'Failed to replay messages',
        timestamp: new Date().toISOString(),
      });
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      (this.wss.clients as any).forEach((ws: any) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  private generateConnectionId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  shutdown() {
    clearInterval(this.heartbeatInterval);
    this.wss.close();
  }
}

declare module 'ws' {
  interface WebSocket {
    isAlive?: boolean;
  }
}
