/**
 * WebSocket broadcaster for real-time arbitrage opportunity streams.
 * Path: /ws/arbitrage/opportunities
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';

interface ArbClient {
  ws: WebSocket;
  minProfit: number;
  minMevScore: number;
  pairs: string[];
}

const clients = new Set<ArbClient>();
let wss: WebSocketServer | null = null;

export function attachArbitrageWebSocket(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws/arbitrage/opportunities' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const minProfit = parseFloat(url.searchParams.get('minProfit') ?? '0');
    const minMevScore = parseInt(url.searchParams.get('minMevScore') ?? '0', 10);
    const pairsParam = url.searchParams.get('pairs');
    const pairs = pairsParam ? pairsParam.split(',') : [];

    const client: ArbClient = { ws, minProfit, minMevScore, pairs };
    clients.add(client);

    ws.send(
      JSON.stringify({
        event: 'connected',
        data: {
          message: 'Arbitrage opportunity stream connected',
          filters: { minProfit, minMevScore, pairs },
        },
      }),
    );

    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return wss;
}

export function broadcastArbitrageOpportunity(opp: {
  id: string;
  pair: string;
  profitPercentage: number;
  mevScore: number;
  type: string;
  route: unknown[];
  detectedAt: string;
  capitalRequired?: string;
  buyDex?: string;
  sellDex?: string;
}) {
  const payload = JSON.stringify({
    event: 'new_opportunity',
    data: {
      id: opp.id,
      pair: opp.pair,
      profitPercentage: opp.profitPercentage,
      mevScore: opp.mevScore,
      type: opp.type,
      route: opp.route,
      detectedAt: opp.detectedAt,
      capitalRequired: opp.capitalRequired,
      buyDex: opp.buyDex,
      sellDex: opp.sellDex,
    },
  });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (opp.profitPercentage < client.minProfit) continue;
    if (opp.mevScore < client.minMevScore) continue;
    if (client.pairs.length > 0 && !client.pairs.includes(opp.pair)) continue;
    client.ws.send(payload);
  }
}

export function getArbitrageWsClientCount(): number {
  return clients.size;
}
