/**
 * Universal KYC Service
 *
 * Manages tiered KYC verification that is shared across all ramp providers:
 *
 *   Tier 1 ($0–$1k/day)   – email + phone only
 *   Tier 2 ($1k–$10k/day) – government ID + liveness check
 *   Tier 3 ($10k+/day)    – full KYC + source of funds
 *
 * Once verified with one provider, the KYC record is reused across others
 * (with explicit user consent captured at session time). Provider-specific
 * customer IDs are stored in `providerKycIds` JSON map.
 *
 * Jurisdiction enforcement:
 *   - FATF grey-listed and black-listed countries are blocked outright.
 *   - Daily/monthly limits are enforced per tier.
 */

import { prismaWrite, prismaRead } from '../../db';
import { logger } from '../../logger';
import type { KycTier, ProviderName } from './types';

// ── FATF / OFAC blocked jurisdictions ────────────────────────────────────────

const BLOCKED_JURISDICTIONS = new Set([
  'IR',
  'KP',
  'SY',
  'CU',
  'SD',
  'MM',
  'RU',
  'BY',
  'VE',
  'AF',
  'YE',
  'LY',
  'SO',
  'SS',
  'ZW',
]);

// ── Tier limits ───────────────────────────────────────────────────────────────

const TIER_LIMITS: Record<KycTier, { dailyUsd: number; monthlyUsd: number }> = {
  tier1: { dailyUsd: 1_000, monthlyUsd: 10_000 },
  tier2: { dailyUsd: 10_000, monthlyUsd: 100_000 },
  tier3: { dailyUsd: 500_000, monthlyUsd: 5_000_000 },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function requiredTierForAmount(dailyAmountUsd: number): KycTier {
  if (dailyAmountUsd > 10_000) return 'tier3';
  if (dailyAmountUsd > 1_000) return 'tier2';
  return 'tier1';
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve or create the KYC record for a user.
 * Never throws — returns null on unexpected DB error.
 */
export async function getOrCreateKycRecord(userId: string, jurisdiction?: string) {
  try {
    const existing = await prismaRead.rampKycRecord.findUnique({ where: { userId } });
    if (existing) return existing;

    return await prismaWrite.rampKycRecord.create({
      data: {
        userId,
        jurisdiction: jurisdiction ?? null,
        tier: 'tier1',
        status: 'pending',
      },
    });
  } catch (err) {
    logger.error('[ramp-kyc] getOrCreateKycRecord failed', { error: String(err), userId });
    return null;
  }
}

/**
 * Check whether a user's KYC record allows a transaction of a given amount.
 *
 * Returns:
 *   { allowed: true, kycId }  – transaction can proceed
 *   { allowed: false, reason } – blocked with reason
 */
export async function checkKycAllowance(
  userId: string,
  fiatAmountUsd: number,
  jurisdiction?: string,
): Promise<{ allowed: true; kycId: string; tier: KycTier } | { allowed: false; reason: string }> {
  // Block sanctioned jurisdictions immediately
  if (jurisdiction && BLOCKED_JURISDICTIONS.has(jurisdiction.toUpperCase())) {
    return { allowed: false, reason: `Jurisdiction ${jurisdiction} is not supported` };
  }

  const kyc = await getOrCreateKycRecord(userId, jurisdiction);
  if (!kyc) {
    return { allowed: false, reason: 'KYC record unavailable' };
  }

  if (kyc.blocked) {
    return { allowed: false, reason: kyc.blockReason ?? 'Account suspended' };
  }

  const neededTier = requiredTierForAmount(fiatAmountUsd);

  // If the user hasn't been verified at the required tier, require KYC upgrade
  const tierOrder: KycTier[] = ['tier1', 'tier2', 'tier3'];
  const currentTierIdx = tierOrder.indexOf(kyc.tier as KycTier);
  const neededTierIdx = tierOrder.indexOf(neededTier);

  if (kyc.status !== 'approved' && neededTierIdx > 0) {
    return {
      allowed: false,
      reason: `KYC required: ${neededTier} verification needed for this transaction amount`,
    };
  }

  if (currentTierIdx < neededTierIdx) {
    return {
      allowed: false,
      reason: `KYC upgrade required: ${neededTier} verification needed for transactions above $${neededTier === 'tier2' ? '1,000' : '10,000'}/day`,
    };
  }

  // Reset usage if calendar day has changed
  const limits = TIER_LIMITS[kyc.tier as KycTier];
  const now = new Date();
  const resetDate = kyc.usageResetAt;
  const needsReset = !resetDate || resetDate.toISOString().slice(0, 10) < todayDateString();

  const dailyUsed = needsReset ? 0 : kyc.dailyUsedUsd;
  const monthlyUsed = kyc.monthlyUsedUsd;

  if (dailyUsed + fiatAmountUsd > limits.dailyUsd) {
    return {
      allowed: false,
      reason: `Daily limit of $${limits.dailyUsd.toLocaleString()} exceeded for ${kyc.tier}`,
    };
  }

  if (monthlyUsed + fiatAmountUsd > limits.monthlyUsd) {
    return {
      allowed: false,
      reason: `Monthly limit of $${limits.monthlyUsd.toLocaleString()} exceeded for ${kyc.tier}`,
    };
  }

  return { allowed: true, kycId: kyc.id, tier: kyc.tier as KycTier };
}

/**
 * Deduct an amount from the user's KYC daily/monthly usage counters.
 * Called after a successful order is created.
 */
export async function recordKycUsage(kycId: string, fiatAmountUsd: number): Promise<void> {
  try {
    const kyc = await prismaRead.rampKycRecord.findUnique({ where: { id: kycId } });
    if (!kyc) return;

    const now = new Date();
    const resetDate = kyc.usageResetAt;
    const needsReset = !resetDate || resetDate.toISOString().slice(0, 10) < todayDateString();

    await prismaWrite.rampKycRecord.update({
      where: { id: kycId },
      data: {
        dailyUsedUsd: needsReset ? fiatAmountUsd : { increment: fiatAmountUsd },
        monthlyUsedUsd: { increment: fiatAmountUsd },
        usageResetAt: needsReset ? now : undefined,
      },
    });
  } catch (err) {
    logger.error('[ramp-kyc] recordKycUsage failed', { error: String(err), kycId });
  }
}

/**
 * Mark KYC as approved at a given tier, recording the provider's customer ID.
 * Supports shared KYC across providers — subsequent providers can reuse this record.
 */
export async function approveKyc(
  userId: string,
  tier: KycTier,
  provider: ProviderName,
  providerCustomerId: string,
  opts: {
    documentType?: string;
    documentCountry?: string;
    livenessScore?: number;
  } = {},
): Promise<void> {
  try {
    const kyc = await getOrCreateKycRecord(userId);
    if (!kyc) return;

    const providerKycIds = (kyc.providerKycIds as Record<string, string>) ?? {};
    providerKycIds[provider] = providerCustomerId;

    const tierLimits = TIER_LIMITS[tier];

    await prismaWrite.rampKycRecord.update({
      where: { id: kyc.id },
      data: {
        tier,
        status: 'approved',
        providerKycIds,
        dailyLimitUsd: tierLimits.dailyUsd,
        monthlyLimitUsd: tierLimits.monthlyUsd,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        pepScreened: true,
        sanctionsScreened: true,
        documentType: opts.documentType ?? kyc.documentType,
        documentCountry: opts.documentCountry ?? kyc.documentCountry,
        livenessScore: opts.livenessScore ?? kyc.livenessScore,
      },
    });

    logger.info('[ramp-kyc] KYC approved', { userId, tier, provider });
  } catch (err) {
    logger.error('[ramp-kyc] approveKyc failed', { error: String(err), userId });
  }
}

/**
 * Block a user's KYC record (e.g. after AML flag resolution).
 */
export async function blockKyc(userId: string, reason: string): Promise<void> {
  await prismaWrite.rampKycRecord.updateMany({
    where: { userId },
    data: { blocked: true, blockReason: reason },
  });
  logger.warn('[ramp-kyc] User blocked', { userId, reason });
}

export { BLOCKED_JURISDICTIONS, TIER_LIMITS, requiredTierForAmount };
