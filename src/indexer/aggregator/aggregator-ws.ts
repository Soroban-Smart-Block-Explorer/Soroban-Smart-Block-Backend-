/**
 * WebSocket Streaming for Aggregator (Issue #334, §12)
 *
 * Real-time price updates, streaming quotes, order updates, and depth updates.
 * Integrates with the existing WebSocket infrastructure.
 */

import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { getAllPools, getPoolById } from './pool-indexer';
import { getMidPrice } from './price-engine';

// Type for WebSocket message handlers
type MessageHandler = (ws: WebSocket, data: any) => void;

interface Subscription {
  ws: WebSocket;
  pairs: string[]; // token pairs to watch
  poolIds: string[]; // specific pools
  userId?: string;
}

// Active subscriptions
const subscriptions = new Map<WebSocket, Subscription>();

// Broadcast interval handles
const priceIntervalHandles = new Map<string, NodeJS.Timeout>();

/**
 * Start broadcasting real-time prices for a pair.
 */
export function startPriceBroadcast(
  pairKey: string,
  intervalMs: number = 2500,
): void {
  if (priceIntervalHandles.has(pairKey)) return;

  const handle = setInterval(() => {
    const [tokenA, tokenB] = pairKey.split('|');
    const pools = getAllPools().filter(
      (p) => (p.tokenA === tokenA && p.tokenB === tokenB) ||
             (p.tokenA === tokenB && p.tokenB === tokenA),
    );

    if (pools.length === 0) return;

    const prices = pools.map((p) => ({
      poolId: p.id,
      dexName: p.dexName,
      poolAddress: p.poolAddress,
      price: getMidPrice(p),
      timestamp: new Date().toISOString(),
    }));

    // Broadcast to all subscribed clients
    const message = JSON.stringify({
      type: 'price_update',
      pair: pairKey,
      prices,
      timestamp: new Date().toISOString(),
    });

    for (const [ws, sub] of subscriptions) {
      if (ws.readyState === WebSocket.OPEN &&
          (sub.pairs.includes(pairKey) || sub.pairs.length === 0)) {
        ws.send(message);
      }
    }
  }, intervalMs);

  priceIntervalHandles.set(pairKey, handle);
}

/**
 * Stop broadcasting prices for a pair.
 */
export function stopPriceBroadcast(pairKey: string): void {
  const handle = priceIntervalHandles.get(pairKey);
  if (handle) {
    clearInterval(handle);
    priceIntervalHandles.delete(pairKey);
  }
}

/**
 * Handle a new WebSocket connection for the aggregator.
 */
export function handleAggregatorWsConnection(
  ws: WebSocket,
  request: IncomingMessage,
): void {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  const pairs = url.searchParams.get('pairs')?.split(',') ?? [];
  const poolIds = url.searchParams.get('pools')?.split(',') ?? [];

  subscriptions.set(ws, { ws, pairs, poolIds });

  // Start broadcasting for requested pairs
  for (const pair of pairs) {
    startPriceBroadcast(pair);
  }

  // Send initial data
  const allPools = getAllPools();
  ws.send(JSON.stringify({
    type: 'initial_data',
    pools: allPools.map((p) => ({
      id: p.id,
      dexName: p.dexName,
      poolAddress: p.poolAddress,
      poolType: p.poolType,
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      feeTier: p.feeTier,
      reserveA: p.reserveA.toString(),
      reserveB: p.reserveB.toString(),
      price: getMidPrice(p),
    })),
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWsMessage(ws, msg);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    const sub = subscriptions.get(ws);
    if (sub) {
      for (const pair of sub.pairs) {
        // Check if any other subscriber needs this pair
        const hasOther = Array.from(subscriptions.values()).some(
          (s) => s !== sub && s.pairs.includes(pair),
        );
        if (!hasOther) stopPriceBroadcast(pair);
      }
    }
    subscriptions.delete(ws);
  });

  ws.on('error', () => {
    subscriptions.delete(ws);
  });

  ws.send(JSON.stringify({
    type: 'connected',
    pairs: allPools.length > 0 ? allPools.map((p) => `${p.tokenA}|${p.tokenB}`) : [],
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Handle incoming WebSocket messages.
 */
function handleWsMessage(ws: WebSocket, msg: any): void {
  const sub = subscriptions.get(ws);
  if (!sub) return;

  switch (msg.type) {
    case 'subscribe':
      if (msg.pairs) {
        for (const pair of msg.pairs) {
          if (!sub.pairs.includes(pair)) {
            sub.pairs.push(pair);
            startPriceBroadcast(pair);
          }
        }
      }
      ws.send(JSON.stringify({ type: 'subscribed', pairs: sub.pairs }));
      break;

    case 'unsubscribe':
      if (msg.pairs) {
        sub.pairs = sub.pairs.filter((p) => !msg.pairs.includes(p));
        for (const pair of msg.pairs) {
          const hasOther = Array.from(subscriptions.values()).some(
            (s) => s !== sub && s.pairs.includes(pair),
          );
          if (!hasOther) stopPriceBroadcast(pair);
        }
      }
      ws.send(JSON.stringify({ type: 'unsubscribed', pairs: sub.pairs }));
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      break;

    case 'depth':
      if (msg.poolId) {
        const pool = getPoolById(msg.poolId);
        if (pool) {
          ws.send(JSON.stringify({
            type: 'depth_update',
            poolId: pool.id,
            reserveA: pool.reserveA.toString(),
            reserveB: pool.reserveB.toString(),
            price: getMidPrice(pool),
            timestamp: new Date().toISOString(),
          }));
        }
      }
      break;
  }
}

/**
 * Clean up all aggregator WebSocket resources.
 */
export function cleanupAggregatorWs(): void {
  for (const [pairKey, handle] of priceIntervalHandles) {
    clearInterval(handle);
  }
  priceIntervalHandles.clear();
  subscriptions.clear();
}
