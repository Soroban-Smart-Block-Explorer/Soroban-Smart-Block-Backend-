/**
 * Weekly Audit Digest Scheduler
 *
 * Posts the weekly audit digest every Monday at 09:00 UTC to all
 * registered Slack/Discord channel subscriptions that have:
 *   - alertTypes includes "certificate_update" (broad subscription)
 *   - slackWebhookUrl or webhookUrl (Discord) configured
 *   - userId starting with "slack:" or "discord:"
 *
 * Also exposes postDigestNow() for manual trigger via API.
 */

import { prismaRead } from '../db';
import { logger } from '../logger';
import { buildWeeklyDigest, postToSlackChannel, postToDiscordChannel } from '../lib/audit-bot';

const BASE_URL = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

// ── Next Monday 09:00 UTC ─────────────────────────────────────────────────────

function msUntilNextMondayNineUTC(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday,
      9,
      0,
      0,
      0,
    ),
  );
  return next.getTime() - now.getTime();
}

// ── Digest dispatch ───────────────────────────────────────────────────────────

export async function postDigestNow(): Promise<{ sent: number; failed: number }> {
  const digest = await buildWeeklyDigest(BASE_URL);
  let sent = 0,
    failed = 0;

  // Find all subscriptions that receive digest (certificate_update includes digest)
  const subs = await prismaRead.auditSubscription.findMany({
    where: {
      isActive: true,
      alertTypes: { has: 'certificate_update' },
      OR: [
        { slackWebhookUrl: { not: null } },
        { webhookUrl: { not: null }, userId: { startsWith: 'discord:' } },
      ],
    },
    select: {
      id: true,
      userId: true,
      slackWebhookUrl: true,
      slackChannel: true,
      webhookUrl: true,
    },
    distinct: ['slackWebhookUrl'],
  });

  for (const sub of subs) {
    try {
      const isDiscord = sub.userId?.startsWith('discord:');
      const isSlack = sub.userId?.startsWith('slack:') || !!sub.slackWebhookUrl;

      if (isSlack && sub.slackWebhookUrl) {
        await postToSlackChannel(
          sub.slackWebhookUrl,
          digest.blocks,
          digest.text,
          sub.slackChannel ?? undefined,
        );
        sent++;
      } else if (isDiscord && sub.webhookUrl) {
        await postToDiscordChannel(sub.webhookUrl, digest.embeds, digest.text);
        sent++;
      }
    } catch (e) {
      logger.warn('Digest delivery failed', { subId: sub.id, error: String(e) });
      failed++;
    }
  }

  logger.info('Weekly digest dispatched', { sent, failed, total: subs.length });
  return { sent, failed };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let digestTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNext(): void {
  const ms = msUntilNextMondayNineUTC();
  logger.info('Digest scheduler: next run', {
    in: `${(ms / 3600000).toFixed(1)} hours`,
    at: new Date(Date.now() + ms).toISOString(),
  });

  digestTimer = setTimeout(async () => {
    try {
      await postDigestNow();
    } catch (e) {
      logger.error('Weekly digest failed', { error: String(e) });
    }
    scheduleNext(); // reschedule for the following Monday
  }, ms);
}

export function startAuditDigestScheduler(): void {
  scheduleNext();
  logger.info('Weekly audit digest scheduler started (every Monday 09:00 UTC)');
}

export function stopAuditDigestScheduler(): void {
  if (digestTimer) {
    clearTimeout(digestTimer);
    digestTimer = null;
  }
}
