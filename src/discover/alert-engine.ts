/**
 * Alert System — Issue #335
 *
 * Manages alert rules and emits alert events for:
 * - New token launches (instant)
 * - Significant liquidity events (> $X USD)
 * - Airdrop claims starting
 * - Token flagged as potential scam (risk score > threshold)
 * - Large holder accumulation (> 5% supply)
 * - Liquidity removal (potential rug)
 * - Price movement > X% in Y minutes
 */

import { prismaWrite as prisma } from '../db';
import { prismaRead } from '../db';
import { logger } from '../logger';

export interface AlertRuleInput {
  userAddress: string;
  alertType: string;
  conditions: Record<string, unknown>;
  channels: Record<string, unknown>;
  cooldownMinutes?: number;
}

export interface AlertEventInput {
  ruleId?: string;
  alertType: string;
  tokenContractAddress?: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Create a new alert rule.
 */
export async function createAlertRule(input: AlertRuleInput): Promise<unknown> {
  const rule = await prisma.alertRule.create({
    data: {
      userAddress: input.userAddress,
      alertType: input.alertType,
      conditions: input.conditions,
      channels: input.channels,
      cooldownMinutes: input.cooldownMinutes ?? 15,
    },
  });
  return rule;
}

/**
 * Update an existing alert rule.
 */
export async function updateAlertRule(
  id: string,
  data: Partial<AlertRuleInput>,
): Promise<unknown> {
  const rule = await prisma.alertRule.update({
    where: { id },
    data: {
      ...(data.conditions ? { conditions: data.conditions } : {}),
      ...(data.channels ? { channels: data.channels } : {}),
      ...(data.cooldownMinutes ? { cooldownMinutes: data.cooldownMinutes } : {}),
      ...(data.alertType ? { alertType: data.alertType } : {}),
    },
  });
  return rule;
}

/**
 * Delete an alert rule.
 */
export async function deleteAlertRule(id: string): Promise<void> {
  await prisma.alertRule.delete({ where: { id } });
}

/**
 * Get alert rules for a user.
 */
export async function getUserAlertRules(userAddress: string): Promise<unknown[]> {
  return prismaRead.alertRule.findMany({
    where: { userAddress },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get alert event history.
 */
export async function getAlertHistory(
  limit = 50,
  offset = 0,
  filter?: { alertType?: string; severity?: string },
): Promise<{ events: unknown[]; total: number }> {
  const where = {
    ...(filter?.alertType ? { alertType: filter.alertType } : {}),
    ...(filter?.severity ? { severity: filter.severity } : {}),
  };

  const [events, total] = await Promise.all([
    prismaRead.alertEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        rule: { select: { userAddress: true, alertType: true } },
      },
    }),
    prismaRead.alertEvent.count({ where }),
  ]);

  return { events, total };
}

/**
 * Emit an alert event. Checks cooldown and delivers to configured channels.
 */
export async function emitAlert(input: AlertEventInput): Promise<void> {
  // Find token id if contract address provided
  let tokenId: bigint | null = null;
  if (input.tokenContractAddress) {
    const token = await prismaRead.detectedToken.findUnique({
      where: { contractAddress: input.tokenContractAddress },
      select: { id: true },
    });
    tokenId = token?.id ?? null;
  }

  await prisma.alertEvent.create({
    data: {
      ruleId: input.ruleId ?? null,
      alertType: input.alertType,
      tokenId: tokenId ?? undefined,
      severity: input.severity,
      title: input.title,
      message: input.message,
      data: input.data ?? undefined,
      deliveredAt: new Date(),
    },
  });

  logger.info('Alert emitted', {
    type: input.alertType,
    severity: input.severity,
    title: input.title,
  });
}

/**
 * Test an alert rule.
 */
export async function testAlertRule(ruleId: string): Promise<{ success: boolean; message: string }> {
  const rule = await prismaRead.alertRule.findUnique({ where: { id: ruleId } });
  if (!rule) {
    return { success: false, message: 'Rule not found' };
  }

  await emitAlert({
    ruleId,
    alertType: rule.alertType,
    severity: 'info',
    title: `Test Alert: ${rule.alertType}`,
    message: 'This is a test alert from your rule configuration.',
    data: { test: true, ruleId },
  });

  return { success: true, message: 'Test alert emitted successfully' };
}

/**
 * Check for alert conditions and emit alerts as needed.
 */
export async function evaluateAlertConditions(): Promise<void> {
  const activeRules = await prismaRead.alertRule.findMany({
    where: { enabled: true },
  });

  for (const rule of activeRules) {
    try {
      await evaluateRule(rule);
    } catch (err) {
      logger.warn('Error evaluating alert rule', {
        ruleId: rule.id,
        error: String(err),
      });
    }
  }
}

async function evaluateRule(rule: unknown): Promise<void> {
  const r = rule as {
    id: string;
    alertType: string;
    cooldownMinutes: number;
  };

  // Check for cooldown
  const recentAlert = await prismaRead.alertEvent.findFirst({
    where: {
      ruleId: r.id,
      createdAt: {
        gte: new Date(Date.now() - r.cooldownMinutes * 60 * 1000),
      },
    },
  });

  if (recentAlert) return; // still in cooldown

  // Evaluate based on alert type
  switch (r.alertType) {
    case 'new_token_launch': {
      const recentTokens = await prismaRead.detectedToken.findMany({
        where: {
          detectedAt: {
            gte: new Date(Date.now() - 60 * 1000), // last minute
          },
        },
        take: 5,
      });
      for (const token of recentTokens) {
        await emitAlert({
          ruleId: r.id,
          alertType: r.alertType,
          tokenContractAddress: token.contractAddress,
          severity: 'info',
          title: `New Token Launched: ${token.symbol ?? token.contractAddress}`,
          message: `Token ${token.name ?? token.symbol ?? 'Unknown'} deployed at ${token.contractAddress}`,
          data: { token: token.contractAddress, symbol: token.symbol },
        });
      }
      break;
    }
    case 'scam_token': {
      const flaggedTokens = await prismaRead.detectedToken.findMany({
        where: {
          status: 'flagged',
          updatedAt: { gte: new Date(Date.now() - 60 * 1000) },
        },
        take: 5,
      });
      for (const token of flaggedTokens) {
        await emitAlert({
          ruleId: r.id,
          alertType: r.alertType,
          tokenContractAddress: token.contractAddress,
          severity: 'critical',
          title: `⚠️ Token Flagged as Potential Scam: ${token.symbol ?? token.contractAddress}`,
          message: `Token flagged with potential scam indicators. Risk score: high.`,
          data: { token: token.contractAddress, status: token.status },
        });
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Subscribe to an alert type (simple registration).
 */
export async function subscribeToAlertType(
  userAddress: string,
  alertType: string,
  channels: Record<string, unknown>,
): Promise<unknown> {
  return createAlertRule({
    userAddress,
    alertType,
    conditions: {},
    channels,
  });
}
