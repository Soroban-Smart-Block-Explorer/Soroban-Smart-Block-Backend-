/**
 * Volume Alert Runner
 *
 * Scheduled script that detects transaction frequency spikes per contract
 * using historical standard deviation, then persists new alerts to VolumeAlert.
 */

import { detectSpikes } from './spikeDetector';
import { prismaWrite } from '../db';

/**
 * Run spike detection and persist any new alerts.
 */
export async function runVolumeAlerts(
  windowMinutes = 5,
  historyWindows = 12,
  zThreshold = 3.0,
): Promise<number> {
  const alerts = await detectSpikes(windowMinutes, historyWindows, zThreshold);

  if (alerts.length === 0) return 0;

  await prismaWrite.volumeAlert.createMany({
    data: alerts.map((a) => ({
      contractAddress: a.contractAddress,
      currentCount:    a.currentCount,
      baseline:        a.baseline,
      stdDev:          a.stdDev,
      zScore:          a.zScore,
      windowMinutes:   a.windowMinutes,
      detectedAt:      a.detectedAt,
    })),
  });

  return alerts.length;
}

/**
 * Start a recurring volume alert job.
 * @param intervalMs How often to run (default: every 5 minutes).
 */
export function startVolumeAlertScheduler(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  runVolumeAlerts().catch((err) => console.error('[volumeAlerts] initial run failed:', err));
  return setInterval(() => {
    runVolumeAlerts().catch((err) => console.error('[volumeAlerts] scheduled run failed:', err));
  }, intervalMs);
}
