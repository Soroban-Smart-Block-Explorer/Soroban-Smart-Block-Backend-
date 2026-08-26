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
import { featureFlags } from './feature-flags';

export interface HttpServerHandle {
  httpServer: Server;
  wssRef: ReturnType<typeof attachWebSocketServer>;
}

export function createHttpServer(app: Express, disabledServices: string[]): HttpServerHandle {
  const httpServer: Server = createServer(app);
  const wssRef = attachWebSocketServer(httpServer);

  if (featureFlags.shouldStartSync('privacyWs')) {
    attachPrivacyWebSocketReal(httpServer);
    logger.info('Privacy WebSocket attached');
  } else if (!featureFlags.isEnabledSync('privacyWs')) {
    disabledServices.push('privacyWS (flag off)');
    logger.debug('Privacy WebSocket disabled (feature flag privacyWs off)');
  } else {
    disabledServices.push('privacyWS (schema unavailable)');
    logger.debug('Privacy WebSocket disabled (required tables missing)');
  }

  if (featureFlags.shouldStartSync('composabilityWs')) {
    try {
      attachComposabilityWebSocketImpl(httpServer);
      logger.info('Composability WebSocket attached');
    } catch (err) {
      logger.warn('Composability WebSocket attachment failed', { error: String(err) });
    }
  } else if (!featureFlags.isEnabledSync('composabilityWs')) {
    disabledServices.push('composabilityWS (flag off)');
    logger.debug('Composability WebSocket disabled (feature flag composabilityWs off)');
  } else {
    disabledServices.push('composabilityWS (schema unavailable)');
    logger.debug('Composability WebSocket disabled (required tables missing)');
  }

  if (featureFlags.shouldStartSync('arbitrageWs')) {
    try {
      attachArbitrageWebSocketImpl(httpServer);
      logger.info('Arbitrage WebSocket attached');
    } catch (err) {
      logger.warn('Arbitrage WebSocket attachment failed', { error: String(err) });
    }
  } else if (!featureFlags.isEnabledSync('arbitrageWs')) {
    disabledServices.push('arbitrageWS (flag off)');
    logger.debug('Arbitrage WebSocket disabled (feature flag arbitrageWs off)');
  } else {
    disabledServices.push('arbitrageWS (schema unavailable)');
    logger.debug('Arbitrage WebSocket disabled (required tables missing)');
  }

  // /ws/audit — score alerts, finding alerts, signals
  attachAuditWebSocket(httpServer);

  return { httpServer, wssRef };
}
