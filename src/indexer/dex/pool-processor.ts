/**
 * DEX analytics background processor.
 *
 * Periodically recomputes the price registry, per-pool metrics (TVL, windowed
 * volume, fees, APR, IL-risk), writes historical snapshots, and rescans for
 * arbitrage. Uses node-cron scheduler for better timing precision, backpressure
 * handling, and error isolation. The metric maths live in {@link pool-math}
 * and are unit tested independently; this module is the DB-bound orchestration.
 *
 * Uses dependency injection for better testability.
 */

import type { PrismaClient } from '@prisma/client';
import { aprPct, toHuman, tvlUsd } from './pool-math';
import { refreshTokenPrices } from './pricing';
import { scanArbitrage } from './arbitrage';
import { scheduler } from '../../scheduler/cron-scheduler';
import type { Logger } from '../../services/container';
import { container } from '../../services/container';

const INTERVAL_MS = Number(process.env.DEX_ANALYTICS_INTERVAL_MS ?? 60_000);
const WINDOWS = {
  h1: 3_600_000,
  h24: 86_400_000,
  d7: 7 * 86_400_000,
  d30: 30 * 86_400_000,
} as const;

// Job ID for the scheduler
const DEX_ANALYTICS_JOB_ID = 'dex-analytics';

interface SwapRow {
  ledgerCloseTime: Date;
  tokenIn: string;
  amountIn: string;
}

/**
 * Class-based DEX analytics processor for better testability and DI support.
 */
export class DexAnalyticsProcessor {
  private dexAnalyticsJobId: string | null = null;

  constructor(
    private prismaWrite: PrismaClient,
    private prismaRead: PrismaClient,
    private logger: Logger,
  ) {}

  /** Sum USD volume of swaps newer than `since`, valuing each by its input token. */
  private sumVolumeUsd(
    swaps: SwapRow[],
    since: number,
    tokenA: string,
    decA: number,
    priceA: number | null,
    decB: number,
    priceB: number | null,
  ): number {
    let total = 0;
    for (const s of swaps) {
      if (s.ledgerCloseTime.getTime() < since) continue;
      const inIsA = s.tokenIn === tokenA;
      const price = inIsA ? priceA : priceB;
      if (price == null) continue;
      total += toHuman(BigInt(s.amountIn), inIsA ? decA : decB) * price;
    }
    return total;
  }

  /**
   * Heuristic 0-100 IL / concentrated-liquidity risk: higher turnover (volume
   * relative to TVL) and reserve-value imbalance both raise the risk of
   * impermanent loss for liquidity providers.
   */
  private ilRiskScore(tvl: number, volume24h: number, valueA: number, valueB: number): number {
    if (tvl <= 0) return 0;
    const turnover = Math.min(1, volume24h / tvl); // 0..1
    const balance = valueA + valueB > 0 ? Math.abs(valueA - valueB) / (valueA + valueB) : 0; // 0..1
    const score = turnover * 60 + balance * 40;
    return Math.round(Math.max(0, Math.min(100, score)));
  }

  /** Recompute and persist metrics + a historical snapshot for one pool. */
  private async computePoolMetrics(poolAddress: string): Promise<void> {
    const pool = await this.prismaRead.dexPool.findUnique({ where: { poolAddress } });
    if (!pool) return;

    const [priceARow, priceBRow] = await Promise.all([
      this.prismaRead.tokenPrice.findUnique({
        where: { tokenAddress: pool.tokenA },
        select: { priceUsd: true },
      }),
      this.prismaRead.tokenPrice.findUnique({
        where: { tokenAddress: pool.tokenB },
        select: { priceUsd: true },
      }),
    ]);
    const priceA = priceARow?.priceUsd ?? null;
    const priceB = priceBRow?.priceUsd ?? null;

    const reserveAHuman = toHuman(BigInt(pool.reserveA), pool.tokenADecimals);
    const reserveBHuman = toHuman(BigInt(pool.reserveB), pool.tokenBDecimals);
    const tvl = tvlUsd(reserveAHuman, priceA, reserveBHuman, priceB);

    const swaps = await this.prismaRead.poolSwap.findMany({
      where: { poolAddress, ledgerCloseTime: { gte: new Date(Date.now() - WINDOWS.d30) } },
      select: { ledgerCloseTime: true, tokenIn: true, amountIn: true },
    });

    const now = Date.now();
    const vol = (w: number) =>
      this.sumVolumeUsd(
        swaps,
        now - w,
        pool.tokenA,
        pool.tokenADecimals,
        priceA,
        pool.tokenBDecimals,
        priceB,
      );
    const volume1h = vol(WINDOWS.h1);
    const volume24h = vol(WINDOWS.h24);
    const volume7d = vol(WINDOWS.d7);
    const volume30d = vol(WINDOWS.d30);

    const fees24h = (volume24h * pool.feeBps) / 10_000;
    const apr = aprPct(fees24h, tvl);
    const risk = this.ilRiskScore(
      tvl,
      volume24h,
      priceA != null ? reserveAHuman * priceA : 0,
      priceB != null ? reserveBHuman * priceB : 0,
    );

    await this.prismaWrite.dexPool.update({
      where: { poolAddress },
      data: {
        tvlUsd: tvl,
        volume1hUsd: volume1h,
        volume24hUsd: volume24h,
        volume7dUsd: volume7d,
        volume30dUsd: volume30d,
        fees24hUsd: fees24h,
        aprPct: apr,
        priceAUsd: priceA,
        priceBUsd: priceB,
        ilRiskScore: risk,
        lastSyncedAt: new Date(),
      },
    });

    await this.prismaWrite.poolSnapshot.create({
      data: {
        poolAddress,
        ledgerSequence: pool.lastEventLedger ?? undefined,
        reserveA: pool.reserveA,
        reserveB: pool.reserveB,
        tvlUsd: tvl,
        volume24hUsd: volume24h,
        fees24hUsd: fees24h,
        aprPct: apr,
        priceAUsd: priceA,
        priceBUsd: priceB,
      },
    });
  }

  /** One full analytics cycle: prices → per-pool metrics → arbitrage scan. */
  async run(): Promise<void> {
    await refreshTokenPrices();
    const pools = await this.prismaRead.dexPool.findMany({
      select: { poolAddress: true },
    });
    for (const p of pools) {
      await this.computePoolMetrics(p.poolAddress).catch((e) =>
        this.logger.error(`[dex-analytics] metrics failed for ${p.poolAddress}:`, e),
      );
    }
    await scanArbitrage().catch((e) =>
      this.logger.error('[dex-analytics] arbitrage scan failed:', e),
    );
  }

  /**
   * Schedule the DEX analytics processor using node-cron.
   */
  startScheduler(): void {
    if (this.dexAnalyticsJobId) {
      this.logger.warn('[dex-analytics] Already scheduled');
      return;
    }

    // Convert interval to cron expression
    let cronExpression = '*/1 * * * *'; // Default: every 1 minute

    if (INTERVAL_MS >= 60_000) {
      const minutes = Math.round(INTERVAL_MS / 60_000);
      if (minutes <= 59) {
        cronExpression = `*/${minutes} * * * *`;
      } else {
        const hours = Math.round(minutes / 60);
        cronExpression = `0 */${hours} * * *`;
      }
    }

    this.logger.info(
      '[dex-analytics] Scheduling with interval',
      INTERVAL_MS,
      'ms (cron:',
      cronExpression,
      ')',
    );

    // Run immediately first
    this.run().catch((e) => this.logger.error('[dex-analytics] initial run error:', e));

    // Register the recurring job
    this.dexAnalyticsJobId = DEX_ANALYTICS_JOB_ID;
    scheduler.register({
      id: this.dexAnalyticsJobId,
      taskName: 'DEX Analytics Processing',
      cronExpression,
      execute: () => this.run(),
      maxDuration: 120_000, // 2 min timeout (DEX analytics can be expensive)
      retryOnFailure: true,
      retryDelayMs: 10_000,
    });
  }

  /**
   * Stop the DEX analytics scheduler.
   */
  stopScheduler(): void {
    if (this.dexAnalyticsJobId) {
      scheduler.stop(this.dexAnalyticsJobId);
      this.dexAnalyticsJobId = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Singleton instance for backward compatibility
// ────────────────────────────────────────────────────────────────────────────

const dexAnalyticsProcessor = new DexAnalyticsProcessor(
  container.getPrismaWrite(),
  container.getPrismaRead(),
  container.getLogger(),
);

/**
 * Run DEX analytics (for backward compatibility).
 * @deprecated Use DexAnalyticsProcessor class instead
 */
export async function runDexAnalytics(): Promise<void> {
  return dexAnalyticsProcessor.run();
}

/**
 * Schedule the DEX analytics processor (for backward compatibility).
 * @deprecated Use DexAnalyticsProcessor class instead
 */
export function scheduleDexAnalytics(): void {
  dexAnalyticsProcessor.startScheduler();
}

/**
 * Stop the DEX analytics scheduler (for backward compatibility).
 * @deprecated Use DexAnalyticsProcessor class instead
 */
export function stopDexAnalytics(): void {
  dexAnalyticsProcessor.stopScheduler();
}

/**
 * Stop the DEX analytics scheduler.
 */
export function stopDexAnalytics(): void {
  if (dexAnalyticsJobId) {
    scheduler.stop(dexAnalyticsJobId);
    dexAnalyticsJobId = null;
  }
}
