/**
 * HTTP server + WebSocket attachment
 *
 * Wraps the Express app in a Node http.Server and attaches the WebSocket
 * upgrades. Optional WebSocket endpoints (privacy, composability, arbitrage)
 * are gated behind feature flags; the audit WebSocket is always attached.
 */

import { createServer, Server } from 'http';
import type { Express } from 'express';

import { logger } from './logger';
import { attachWebSocketServer } from './ws/websocketServer';
import { attachPrivacyWebSocket as attachPrivacyWebSocketReal } from './ws/privacyBroadcaster';
import { attachComposabilityWebSocket as attachComposabilityWebSocketImpl } from './ws/composabilityBroadcaster';
import { attachArbitrageWebSocket as attachArbitrageWebSocketImpl } from './ws/arbitrageBroadcaster';
import { attachAuditWebSocket } from './ws/auditBroadcaster';

export interface HttpServerHandle {
  httpServer: Server;
  wssRef: ReturnType<typeof attachWebSocketServer>;
}

export function createHttpServer(app: Express, disabledServices: string[]): HttpServerHandle {
  const httpServer: Server = createServer(app);
  const wssRef = attachWebSocketServer(httpServer);

  const enablePrivacyWs = process.env.ENABLE_PRIVACY_WS === 'true';
  const enableComposabilityWs = process.env.ENABLE_COMPOSABILITY_WS === 'true';
  const enableArbitrageWs = process.env.ENABLE_ARBITRAGE_WS === 'true';

  if (enablePrivacyWs) {
    attachPrivacyWebSocketReal(httpServer);
    logger.info('Privacy WebSocket attached');
  } else {
    disabledServices.push('privacyWS');
    logger.debug('Privacy WebSocket disabled (ENABLE_PRIVACY_WS not set)');
  }

  if (enableComposabilityWs) {
    try {
      attachComposabilityWebSocketImpl(httpServer);
      logger.info('Composability WebSocket attached');
    } catch (err) {
      logger.warn('Composability WebSocket attachment failed', { error: String(err) });
    }
  } else {
    disabledServices.push('composabilityWS');
    logger.debug('Composability WebSocket disabled (ENABLE_COMPOSABILITY_WS not set)');
  }

  if (enableArbitrageWs) {
    try {
      attachArbitrageWebSocketImpl(httpServer);
      logger.info('Arbitrage WebSocket attached');
    } catch (err) {
      logger.warn('Arbitrage WebSocket attachment failed', { error: String(err) });
    }
  } else {
    disabledServices.push('arbitrageWS');
    logger.debug('Arbitrage WebSocket disabled (ENABLE_ARBITRAGE_WS not set)');
  }

  // /ws/audit — score alerts, finding alerts, signals
  attachAuditWebSocket(httpServer);

  return { httpServer, wssRef };
}
