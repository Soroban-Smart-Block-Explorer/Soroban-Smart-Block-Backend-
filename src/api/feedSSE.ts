import { Router } from 'express';
import { ChannelManager } from '../feed/channelManager';
import { streamingServer, SSEStreamConnection } from '../feed/streamingServer';
import { logger } from '../logger';

const router = Router();

router.get('/', (req, res) => {
  const connectionId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const channels = (req.query.channels as string)?.split(',') || [];
  let filters = {};

  if (req.query.filters) {
    try {
      filters = JSON.parse(req.query.filters as string);
    } catch {
      return res.status(400).json({ error: 'Invalid filters JSON' });
    }
  }

  for (const channel of channels) {
    if (!ChannelManager.isValidChannel(channel)) {
      return res.status(400).json({ error: `Invalid channel: ${channel}` });
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });

  const connection = new SSEStreamConnection(connectionId, res, channels, filters);
  streamingServer.addConnection(connection);

  connection.send('connected', {
    connectionId,
    channels,
    timestamp: new Date().toISOString(),
  });

  logger.info(`SSE connected: ${connectionId}, channels: ${channels.join(', ')}`);

  const heartbeat = setInterval(() => {
    connection.send('heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    streamingServer.removeConnection(connectionId);
    logger.info(`SSE disconnected: ${connectionId}`);
  });

  const lastEventId = req.headers['last-event-id'] as string;
  if (lastEventId) {
    const lastSequence = Number(lastEventId);
    if (!isNaN(lastSequence)) {
      streamingServer
        .replay(connection, lastSequence)
        .then((count) => {
          if (count > 0) {
            connection.send('replay_complete', {
              replayedCount: count,
              timestamp: new Date().toISOString(),
            });
          }
        })
        .catch((err) => {
          logger.error('Replay error:', err);
          connection.send('error', {
            message: 'Failed to replay missed events',
            timestamp: new Date().toISOString(),
          });
        });
    }
  }
});

export function getSSEStats() {
  const channelStats = streamingServer.getChannelStats();
  return {
    totalConnections: streamingServer.getConnectionCount(),
    channelStats: Object.fromEntries(channelStats),
  };
}

export default router;
