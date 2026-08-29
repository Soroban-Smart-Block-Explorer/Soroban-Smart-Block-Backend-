import { prismaRead, prismaWrite } from '../../db';
import { logger } from '../../logger';
import { computeCompositePrice } from './composite-price';
import { updateStablecoinMonitoring, autoDetectStablecoin } from './stablecoin-peg';
import { discoverExternalPrice } from './external-api-source';
import { scheduler } from '../../scheduler/cron-scheduler';

let isRunning = false;
let activeInterval: ReturnType<typeof setInterval> | null = null;
let slowInterval: ReturnType<typeof setInterval> | null = null;
let stableInterval: ReturnType<typeof setInterval> | null = null;
let externalInterval: ReturnType<typeof setInterval> | null = null;

const ACTIVE_PAIR_INTERVAL_MS = 30_000;
const INACTIVE_PAIR_INTERVAL_MS = 5 * 60_000;
const STABLE_MONITOR_INTERVAL_MS = 60_000;
const EXTERNAL_API_INTERVAL_MS = 5 * 60_000;

export async function runActivePriceUpdate(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const activeTokens = await prismaRead.contract.findMany({
      where: { isToken: true },
      select: { address: true, tokenSymbol: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    const batchSize = 10;
    for (let i = 0; i < activeTokens.length; i += batchSize) {
      const batch = activeTokens.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((t) => computeCompositePrice(t.address, t.tokenSymbol)));
    }

    await prismaWrite.$executeRawUnsafe(`
      UPDATE "TokenPrice"
      SET "updatedAt" = NOW()
      WHERE "updatedAt" < NOW() - INTERVAL '5 minutes'
    `);

    scheduler.recordHeartbeat('price-updater:active', 'success', {
      taskName: 'Active Pair Price Update',
      expectedIntervalMs: ACTIVE_PAIR_INTERVAL_MS,
    });
  } catch (err) {
    logger.error('[PriceUpdater] Active update error:', { error: err });
    scheduler.recordHeartbeat('price-updater:active', 'failure', {
      taskName: 'Active Pair Price Update',
      expectedIntervalMs: ACTIVE_PAIR_INTERVAL_MS,
    });
  } finally {
    isRunning = false;
  }
}

export async function runSlowPriceUpdate(): Promise<void> {
  try {
    const allTokens = await prismaRead.contract.findMany({
      where: { isToken: true },
      select: { address: true, tokenSymbol: true },
    });

    const batchSize = 20;
    for (let i = 0; i < allTokens.length; i += batchSize) {
      const batch = allTokens.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((t) => computeCompositePrice(t.address, t.tokenSymbol)));
    }

    scheduler.recordHeartbeat('price-updater:slow', 'success', {
      taskName: 'Inactive Pair Price Update',
      expectedIntervalMs: INACTIVE_PAIR_INTERVAL_MS,
    });
  } catch (err) {
    logger.error('[PriceUpdater] Slow update error:', { error: err });
    scheduler.recordHeartbeat('price-updater:slow', 'failure', {
      taskName: 'Inactive Pair Price Update',
      expectedIntervalMs: INACTIVE_PAIR_INTERVAL_MS,
    });
  }
}

export async function runExternalApiUpdate(): Promise<void> {
  try {
    const tokens = await prismaRead.contract.findMany({
      where: { isToken: true, tokenSymbol: { not: null } },
      select: { address: true, tokenSymbol: true },
      take: 30,
    });

    for (const token of tokens) {
      try {
        const extPrice = await discoverExternalPrice(token.address, token.tokenSymbol);
        if (extPrice) {
          const existing = await prismaRead.tokenPrice.findUnique({
            where: { tokenAddress: token.address },
          });
          if (existing && extPrice.confidence > 0.5) {
            await prismaWrite.tokenPrice.upsert({
              where: { tokenAddress: token.address },
              create: {
                tokenAddress: token.address,
                priceUsd: extPrice.priceUsd,
                priceXlm: extPrice.priceUsd * 2.5,
                source: extPrice.source,
                confidence: extPrice.confidence,
                volume24hUsd: extPrice.volume24hUsd || null,
                marketCapUsd: extPrice.marketCapUsd || null,
                updatedAt: new Date(),
              },
              update: {
                priceUsd: extPrice.priceUsd,
                priceXlm: extPrice.priceUsd * 2.5,
                source: extPrice.source,
                confidence: extPrice.confidence,
                volume24hUsd: extPrice.volume24hUsd || null,
                marketCapUsd: extPrice.marketCapUsd || null,
                updatedAt: new Date(),
              },
            });
          }
        }
      } catch {
        continue;
      }
    }

    scheduler.recordHeartbeat('price-updater:external', 'success', {
      taskName: 'External API Price Update',
      expectedIntervalMs: EXTERNAL_API_INTERVAL_MS,
    });
  } catch (err) {
    logger.error('[PriceUpdater] External API update error:', { error: err });
    scheduler.recordHeartbeat('price-updater:external', 'failure', {
      taskName: 'External API Price Update',
      expectedIntervalMs: EXTERNAL_API_INTERVAL_MS,
    });
  }
}

export async function startPriceUpdater(): Promise<void> {
  logger.info('[PriceUpdater] Starting background price updates...');

  if (activeInterval) clearInterval(activeInterval);
  if (slowInterval) clearInterval(slowInterval);
  if (stableInterval) clearInterval(stableInterval);

  await runActivePriceUpdate();
  await runStablecoinUpdate();

  activeInterval = setInterval(runActivePriceUpdate, ACTIVE_PAIR_INTERVAL_MS);
  slowInterval = setInterval(runSlowPriceUpdate, INACTIVE_PAIR_INTERVAL_MS);
  stableInterval = setInterval(runStablecoinUpdate, STABLE_MONITOR_INTERVAL_MS);
  externalInterval = setInterval(runExternalApiUpdate, EXTERNAL_API_INTERVAL_MS);
  setTimeout(() => runExternalApiUpdate(), 10_000);

  logger.info('[PriceUpdater] Background price updates started');
}

export async function runStablecoinUpdate(): Promise<void> {
  try {
    await updateStablecoinMonitoring();

    const tokens = await prismaRead.contract.findMany({
      where: { isToken: true, tokenSymbol: { not: null } },
      select: { address: true, tokenSymbol: true },
    });

    for (const token of tokens) {
      if (token.tokenSymbol) {
        const existing = await prismaRead.token.findUnique({
          where: { address: token.address },
        });

        if (!existing) {
          const isStable = await autoDetectStablecoin(token.address);
          await prismaWrite.token.create({
            data: {
              address: token.address,
              symbol: token.tokenSymbol,
              isStablecoin: isStable,
              tags: isStable ? ['stablecoin'] : [],
            },
          });
        }
      }
    }

    scheduler.recordHeartbeat('price-updater:stablecoin', 'success', {
      taskName: 'Stablecoin Monitoring Update',
      expectedIntervalMs: STABLE_MONITOR_INTERVAL_MS,
    });
  } catch (err) {
    logger.error('[PriceUpdater] Stablecoin update error:', { error: err });
    scheduler.recordHeartbeat('price-updater:stablecoin', 'failure', {
      taskName: 'Stablecoin Monitoring Update',
      expectedIntervalMs: STABLE_MONITOR_INTERVAL_MS,
    });
  }
}

export function stopPriceUpdater(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
  if (slowInterval) {
    clearInterval(slowInterval);
    slowInterval = null;
  }
  if (stableInterval) {
    clearInterval(stableInterval);
    stableInterval = null;
  }
  if (externalInterval) {
    clearInterval(externalInterval);
    externalInterval = null;
  }
  logger.info('[PriceUpdater] Background price updates stopped');
}
