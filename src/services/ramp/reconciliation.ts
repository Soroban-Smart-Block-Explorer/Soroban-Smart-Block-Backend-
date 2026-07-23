/**
 * Reconciliation Engine
 *
 * Runs daily per-provider reconciliation:
 *   1. Fetches all platform orders for a provider on a given date.
 *   2. Polls each order's current status from the provider.
 *   3. Flags any divergence between platform state and provider state.
 *   4. Writes a RampReconciliation record with error rate and discrepancy list.
 *
 * Target: < 0.1% reconciliation error rate.
 *
 * Intended to be called from a scheduled job (e.g. daily cron).
 */

import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';
import { getProviderOrderStatus } from './gateway';
import { transitionOrder } from './order-management';
import type { ProviderName, OrderStatus } from './types';

// ── Run a single reconciliation ───────────────────────────────────────────────

export async function runReconciliation(
  provider: ProviderName,
  periodDate: string, // YYYY-MM-DD
): Promise<{
  ordersChecked: number;
  discrepancyCount: number;
  totalVolumeUsd: number;
  errorRate: number;
}> {
  // Upsert reconciliation record — set status to 'running'
  const rec = await prismaWrite.rampReconciliation.upsert({
    where: { provider_periodDate: { provider, periodDate } },
    create: { provider, periodDate, status: 'running' },
    update: { status: 'running', runAt: new Date() },
  });

  const dayStart = new Date(`${periodDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${periodDate}T23:59:59.999Z`);

  const orders = await prismaRead.rampOrder.findMany({
    where: {
      provider,
      createdAt: { gte: dayStart, lte: dayEnd },
      providerOrderId: { not: null },
      status: { in: ['processing', 'completed', 'failed', 'pending'] },
    },
    select: {
      id: true,
      providerOrderId: true,
      status: true,
      fiatAmount: true,
    },
  });

  let discrepancyCount = 0;
  let totalVolumeUsd = 0;
  const discrepancies: Array<{
    orderId: string;
    platformStatus: string;
    providerStatus: string;
    fiatAmount: number;
  }> = [];

  for (const order of orders) {
    totalVolumeUsd += order.fiatAmount;

    if (!order.providerOrderId) continue;

    try {
      const providerStatus = await getProviderOrderStatus(
        provider,
        order.providerOrderId,
      );

      const platformStatus = order.status as OrderStatus;
      const remoteStatus = providerStatus.status;

      if (remoteStatus !== platformStatus && isSignificantDiscrepancy(platformStatus, remoteStatus)) {
        discrepancyCount++;
        discrepancies.push({
          orderId: order.id,
          platformStatus,
          providerStatus: remoteStatus,
          fiatAmount: order.fiatAmount,
        });

        // Auto-heal: if provider says completed but we say processing, update
        if (
          remoteStatus === 'completed' &&
          (platformStatus === 'processing' || platformStatus === 'pending')
        ) {
          await transitionOrder(order.id, 'completed', 'system', {
            txHash: providerStatus.txHash,
            cryptoAmount: providerStatus.cryptoAmount,
            reconciledAt: new Date().toISOString(),
          });
        }

        // Auto-heal: if provider says failed but we say pending/processing
        if (
          remoteStatus === 'failed' &&
          (platformStatus === 'pending' || platformStatus === 'processing')
        ) {
          await transitionOrder(order.id, 'failed', 'system', {
            failureReason: `Reconciliation: provider reports ${remoteStatus}`,
          });
        }
      }
    } catch (err) {
      logger.warn('[ramp-reconciliation] status poll failed', {
        orderId: order.id,
        error: String(err),
      });
      // Count poll failures as discrepancies since we can't verify state
      discrepancyCount++;
      discrepancies.push({
        orderId: order.id,
        platformStatus: order.status,
        providerStatus: 'poll_error',
        fiatAmount: order.fiatAmount,
      });
    }
  }

  const errorRate = orders.length > 0 ? discrepancyCount / orders.length : 0;

  await prismaWrite.rampReconciliation.update({
    where: { id: rec.id },
    data: {
      status: 'completed',
      ordersChecked: orders.length,
      discrepancyCount,
      discrepancies,
      totalVolumeUsd,
      errorRate,
      runAt: new Date(),
    },
  });

  logger.info('[ramp-reconciliation] completed', {
    provider,
    periodDate,
    ordersChecked: orders.length,
    discrepancyCount,
    errorRate: (errorRate * 100).toFixed(3) + '%',
  });

  return { ordersChecked: orders.length, discrepancyCount, totalVolumeUsd, errorRate };
}

// ── Run reconciliation for all providers ──────────────────────────────────────

export async function runDailyReconciliation(periodDate?: string): Promise<void> {
  const date = periodDate ?? new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const providers: ProviderName[] = ['moonpay', 'transak', 'ramp', 'banxa', 'stripe'];

  await Promise.allSettled(
    providers.map((p) =>
      runReconciliation(p, date).catch((err) =>
        logger.error('[ramp-reconciliation] provider run failed', {
          provider: p,
          error: String(err),
        }),
      ),
    ),
  );
}

// ── Get reconciliation summary ────────────────────────────────────────────────

export async function getReconciliationSummary(provider: ProviderName, periodDate: string) {
  return prismaRead.rampReconciliation.findUnique({
    where: { provider_periodDate: { provider, periodDate } },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSignificantDiscrepancy(platform: OrderStatus, provider: OrderStatus): boolean {
  // Not a discrepancy if both are terminal states that match
  if (platform === provider) return false;

  // pending → processing is an expected lag, not a discrepancy
  if (platform === 'pending' && provider === 'processing') return false;

  return true;
}
