/**
 * Background Arbitrage Scanner
 * Continuously monitors DEX pools, detects opportunities, scores them,
 * broadcasts via WebSocket, and triggers sandwich detection.
 */

import { logger } from '../logger';
import { background } from '../utils/background';
import {
  detectDirectArbitrage,
  buildPriceGraph,
  detectNegativeCycles,
  persistOpportunity,
  expireStaleOpportunities,
  detectSandwichAttacks,
  detectAndUpdateBots,
} from './arbitrage-engine';
import { broadcastArbitrageOpportunity } from '../ws/arbitrageBroadcaster';
import { prismaRead, prismaWrite } from '../db';

const SCAN_INTERVAL_MS = 1000; // 1 second price scan
const BOT_SCAN_INTERVAL_MS = 300000; // 5 minutes bot scan
const SANDWICH_SCAN_INTERVAL_MS = 5000; // 5 seconds sandwich scan

let scannerRunning = false;

async function scanOpportunities() {
  try {
    await expireStaleOpportunities();

    // Detect direct arbitrage across all DEX pairs
    const directOpps = await detectDirectArbitrage(0.1);

    for (const opp of directOpps.slice(0, 20)) {
      try {
        const id = await persistOpportunity(opp);

        // Broadcast to WebSocket subscribers
        const score = await prismaRead.mevOpportunityScore.findUnique({
          where: { opportunityId: id },
        });

        broadcastArbitrageOpportunity({
          id,
          pair: opp.pair,
          profitPercentage: opp.profitPercentage,
          mevScore: Number(score?.overallScore ?? 0),
          type: 'direct',
          route: [],
          detectedAt: new Date().toISOString(),
          buyDex: opp.buyPool.dexName,
          sellDex: opp.sellPool.dexName,
        });
      } catch {
        // Skip duplicate opportunities (unique constraint)
      }
    }

    // Also detect multi-hop / triangular via price graph
    const graph = await buildPriceGraph();
    const cycles = detectNegativeCycles(graph, 4);

    for (const cycle of cycles.slice(0, 5)) {
      try {
        const profitPct = (cycle.profitMultiplier - 1) * 100;
        const type = cycle.path.length > 3 ? 'triangular' : 'multi_hop';
        const tokenA = cycle.path[0];
        const tokenB = cycle.path[cycle.path.length - 2] ?? cycle.path[1];
        const symA = tokenA.slice(0, 6);
        const symB = tokenB.slice(0, 6);

        const opp = await prismaWrite.arbitrageOpportunity.create({
          data: {
            pair: `${symA}/${symB}`,
            tokenA,
            tokenB,
            type,
            buyPrice: cycle.profitMultiplier,
            sellPrice: 1.0,
            profitPercentage: profitPct,
            confidence: Math.min(0.95, 0.6 + profitPct * 0.05),
            route: cycle.path.map((tok, i) => ({
              action: 'swap',
              dex: cycle.dexNames[i] ?? '',
              poolId: cycle.poolIds[i] ?? '',
              tokenIn: tok,
              tokenOut: cycle.path[i + 1] ?? cycle.path[0],
              expectedOutput: '0',
            })) as unknown as import('@prisma/client').Prisma.InputJsonValue,
            status: 'active',
            detectedAt: new Date(),
            expiredAt: new Date(Date.now() + 30000),
          },
        });

        broadcastArbitrageOpportunity({
          id: opp.id,
          pair: opp.pair,
          profitPercentage: profitPct,
          mevScore: 0,
          type,
          route: cycle.path,
          detectedAt: new Date().toISOString(),
        });
      } catch {
        // skip duplicates
      }
    }
  } catch (err) {
    logger.warn('[arbitrage-scanner] Scan error', { error: String(err) });
  }
}

async function scanSandwiches() {
  try {
    const lastLedger = await prismaRead.indexerState.findUnique({ where: { id: 'singleton' } });
    if (!lastLedger || lastLedger.lastLedger === 0) return;
    await detectSandwichAttacks(lastLedger.lastLedger);
  } catch (err) {
    logger.warn('[arbitrage-scanner] Sandwich scan error', { error: String(err) });
  }
}

export function startArbitrageScanner() {
  if (scannerRunning) return;
  scannerRunning = true;

  logger.info('[arbitrage-scanner] Starting real-time arbitrage detection');

  // Opportunity scan every second
  setInterval(() => {
    background('arbitrage.scanOpportunities', () => scanOpportunities().then(() => {}));
  }, SCAN_INTERVAL_MS);

  // Sandwich detection every 5 seconds
  setInterval(() => {
    background('arbitrage.scanSandwiches', () => scanSandwiches().then(() => {}));
  }, SANDWICH_SCAN_INTERVAL_MS);

  // Bot detection every 5 minutes
  setInterval(() => {
    detectAndUpdateBots().catch((err) => {
      logger.warn('[arbitrage-scanner] Bot detection error', { error: String(err) });
    });
  }, BOT_SCAN_INTERVAL_MS);

  // Run initial scan immediately
  background('arbitrage.scanOpportunities', () => scanOpportunities().then(() => {}));
}
