/**
 * Portfolio Scanner
 *
 * Reads contract balance maps (SAC-mapped assets) to compute total live token
 * holdings, then converts raw token counts into fiat valuations (USD / XLM)
 * using public pricing APIs. Snapshots are persisted to PortfolioSnapshot.
 */

import { computeAssetMetrics } from './assetTracker';
import { prismaWrite } from '../db';

/**
 * Scan all SAC-mapped assets, compute fiat valuations, and persist a snapshot.
 */
export async function runPortfolioScan(): Promise<void> {
  const metrics = await computeAssetMetrics();

  if (metrics.length === 0) return;

  const snapshotAt = new Date();

  await prismaWrite.portfolioSnapshot.createMany({
    data: metrics.map((m) => ({
      contractAddress: m.contractAddress,
      assetCode: m.assetCode ?? null,
      assetIssuer: m.assetIssuer ?? null,
      estimatedVolume: m.estimatedVolume,
      priceXlm: m.priceXlm ?? null,
      priceUsd: m.priceUsd ?? null,
      valueXlm: m.volumeXlm ?? null,
      valueUsd: m.volumeUsd ?? null,
      snapshotAt,
    })),
  });
}

/**
 * Start a recurring portfolio scan.
 * @param intervalMs How often to run (default: every 15 minutes).
 */
export function startPortfolioScanner(intervalMs = 15 * 60 * 1000): NodeJS.Timeout {
  runPortfolioScan().catch((err) => console.error('[portfolioScanner] initial run failed:', err));
  return setInterval(() => {
    runPortfolioScan().catch((err) =>
      console.error('[portfolioScanner] scheduled run failed:', err),
    );
  }, intervalMs);
}
