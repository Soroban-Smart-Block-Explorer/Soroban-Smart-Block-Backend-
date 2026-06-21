import { Router, Response } from 'express';
import { ChannelManager } from '../feed/channelManager';
import { SubscriptionManager } from '../feed/subscriptionManager';
import { feedOrchestrator } from '../feed/orchestrator';
import { prisma } from '../db';

const router = Router();

interface SSEConnection {
  id: string;
  response: Response;
  channels: string[];
  filters: any;
  lastEventId?: string;
}

const connections = new Map<string, SSEConnection>();

// GET /api/v1/feed/sse - Server-Sent Events stream
router.get('/', (req, res) => {
  const connectionId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const channels = (req.query.channels as string)?.split(',') || [];
  let filters = {};

  if (req.query.filters) {
    try {
      filters = JSON.parse(req.query.filters as string);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid filters JSON' });
    }
  }

  // Validate channels
  for (const channel of channels) {
    if (!ChannelManager.isValidChannel(channel)) {
      return res.status(400).json({ error: `Invalid channel: ${channel}` });
    }
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });

  // Send initial connection event
  sendSSE(res, 'connected', {
    connectionId,
    channels,
    timestamp: new Date().toISOString(),
  });

  const connection: SSEConnection = {
    id: connectionId,
    response: res,
    channels,
    filters,
    lastEventId: req.headers['last-event-id'] as string,
  };

  connections.set(connectionId, connection);
  console.log(`SSE connected: ${connectionId}, channels: ${channels.join(', ')}`);

  // Handle client disconnect
  req.on('close', () => {
    connections.delete(connectionId);
    console.log(`SSE disconnected: ${connectionId}`);
  });

  // Keep connection alive
  const heartbeat = setInterval(() => {
    if (connections.has(connectionId)) {
      sendSSE(res, 'heartbeat', { timestamp: new Date().toISOString() });
    } else {
      clearInterval(heartbeat);
    }
  }, 30000); // 30 seconds

  // Handle reconnection with replay
  if (connection.lastEventId) {
    replayMissedEvents(connection).catch(console.error);
  }
});

// Listen for feed messages and broadcast to SSE connections
feedOrchestrator.on('message', (message) => {
  broadcastToSSE(message);
});

function sendSSE(res: Response, event: string, data: any, id?: string) {
  if (id) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastToSSE(message: any) {
  for (const connection of connections.values()) {
    try {
      // Check if connection is interested in this channel
      if (!connection.channels.includes(message.channelName)) {
        continue;
      }

      // Apply filters
      const subscriptionManager = new SubscriptionManager();
      if (!subscriptionManager.matchesFilters(message.data, connection.filters)) {
        continue;
      }

      // Send message
      sendSSE(
        connection.response,
        'message',
        {
          channel: message.channelName,
          sequence: message.sequence?.toString(),
          data: message.data,
          timestamp: message.timestamp,
        },
        message.sequence?.toString(),
      );
    } catch (error) {
      console.error(`Failed to send SSE to ${connection.id}:`, error);
      connections.delete(connection.id);
    }
  }
}

async function replayMissedEvents(connection: SSEConnection) {
  try {
    const lastSequence = BigInt(connection.lastEventId || '0');

    // Get missed messages from database
    const missedMessages = await prisma.feedMessage.findMany({
      where: {
        channelName: { in: connection.channels },
        sequence: { gt: lastSequence },
      },
      orderBy: { sequence: 'asc' },
      take: 100, // Limit to prevent overwhelming
    });

    const subscriptionManager = new SubscriptionManager();

    for (const message of missedMessages) {
      if (subscriptionManager.matchesFilters(message.data, connection.filters)) {
        sendSSE(
          connection.response,
          'message',
          {
            channel: message.channelName,
            sequence: message.sequence.toString(),
            data: message.data,
            timestamp: message.timestamp,
          },
          message.sequence.toString(),
        );
      }
    }

    if (missedMessages.length > 0) {
      sendSSE(connection.response, 'replay_complete', {
        replayedCount: missedMessages.length,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error(`Failed to replay events for ${connection.id}:`, error);
    sendSSE(connection.response, 'error', {
      message: 'Failed to replay missed events',
      timestamp: new Date().toISOString(),
    });
  }
}

export function getSSEStats() {
  const channelStats = new Map<string, number>();

  for (const connection of connections.values()) {
    for (const channel of connection.channels) {
      channelStats.set(channel, (channelStats.get(channel) || 0) + 1);
    }
  }

  return {
    totalConnections: connections.size,
    channelStats: Object.fromEntries(channelStats),
  };
}

export default router;
