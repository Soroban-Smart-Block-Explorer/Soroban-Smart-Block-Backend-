/**
 * Audit Bot HTTP Endpoints
 *
 * POST /api/v1/audit/bot/slack          — Slack slash command receiver
 * POST /api/v1/audit/bot/discord        — Discord interactions endpoint
 * POST /api/v1/audit/bot/digest/trigger — Manual digest trigger (admin)
 * GET  /api/v1/audit/bot/channels       — List subscribed channels
 *
 * Slack setup:
 *   1. Create a Slack App at https://api.slack.com/apps
 *   2. Add a Slash Command pointing to POST /api/v1/audit/bot/slack
 *   3. Set SLACK_SIGNING_SECRET env var
 *   4. Add an Incoming Webhook for your workspace
 *
 * Discord setup:
 *   1. Create a Discord application at https://discord.com/developers
 *   2. Add a bot and register a /audit slash command
 *   3. Set DISCORD_PUBLIC_KEY env var (from app settings)
 *   4. Point Interactions Endpoint to POST /api/v1/audit/bot/discord
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead } from '../db';
import { logger } from '../logger';
import {
  handleSlashCommand,
  verifySlackSignature,
  verifyDiscordSignature,
  buildWeeklyDigest,
  postToSlackChannel,
  postToDiscordChannel,
} from '../lib/audit-bot';
import { postDigestNow } from '../indexer/audit-digest-scheduler';

export const auditBotRouter = Router();

const BASE_URL = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

// ── POST /slack — Slack slash command ─────────────────────────────────────────
// Slack sends application/x-www-form-urlencoded with signature headers.
// We must respond within 3 seconds; heavy work goes in background.

auditBotRouter.post('/slack', async (req: Request, res: Response) => {
  try {
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    const timestamp = (req.headers['x-slack-request-timestamp'] as string) ?? '';
    const signature = (req.headers['x-slack-signature'] as string) ?? '';

    // Reconstruct the raw body string for signature verification
    const rawBody = new URLSearchParams(req.body as Record<string, string>).toString();

    if (signingSecret && !verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid Slack signature' });
    }

    // Parse Slack slash command payload
    const body = req.body as {
      command?: string;
      text?: string;
      channel_id?: string;
      channel_name?: string;
      response_url?: string;
      user_id?: string;
      team_id?: string;
    };

    const text = (body.text ?? '').trim();
    const channelId = body.channel_id ?? '';
    const channelName = body.channel_name ? `#${body.channel_name}` : channelId;
    const responseUrl = body.response_url ?? '';

    // Acknowledge immediately (Slack requires < 3 s)
    res.json({ response_type: 'ephemeral', text: '⏳ Fetching audit data...' });

    // Process in background
    handleSlashCommand('slack', text, channelId, channelName, responseUrl, BASE_URL)
      .then(async (result) => {
        // Post the real response to response_url
        if (!responseUrl) return;
        const payload: Record<string, unknown> = {
          response_type: result.responseType,
          text: result.text ?? '',
        };
        if (result.blocks) payload.blocks = result.blocks;
        await postToSlackChannel(responseUrl, result.blocks ?? [], result.text ?? '', undefined);
      })
      .catch((e) => logger.warn('Slack command processing failed', { error: String(e) }));
  } catch (e) {
    logger.error('Slack endpoint error', { error: String(e) });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /discord — Discord interactions endpoint ─────────────────────────────
// Discord requires PING/PONG for verification, then handles slash command interactions.
// Must respond within 3 seconds with type:4 (CHANNEL_MESSAGE_WITH_SOURCE) or
// type:5 (DEFERRED_CHANNEL_MESSAGE) then follow up.

auditBotRouter.post('/discord', async (req: Request, res: Response) => {
  try {
    const publicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
    const signature = (req.headers['x-signature-ed25519'] as string) ?? '';
    const timestamp = (req.headers['x-signature-timestamp'] as string) ?? '';
    const rawBody = JSON.stringify(req.body);

    if (publicKey && !verifyDiscordSignature(publicKey, timestamp, rawBody, signature)) {
      return res.status(401).send('Invalid request signature');
    }

    const interaction = req.body as {
      type: number;
      id?: string;
      token?: string;
      data?: {
        name?: string;
        options?: Array<{ name: string; value: string }>;
      };
      guild_id?: string;
      channel_id?: string;
    };

    // PING — Discord health check
    if (interaction.type === 1) {
      return res.json({ type: 1 });
    }

    // APPLICATION_COMMAND (slash command)
    if (interaction.type === 2) {
      const subOption = interaction.data?.options?.[0];
      const text =
        subOption?.value ?? interaction.data?.options?.map((o) => o.value).join(' ') ?? '';
      const channelId = interaction.channel_id ?? '';
      const guildId = interaction.guild_id ?? '';
      const token = interaction.token ?? '';

      // Deferred response — allows up to 15 minutes for follow-up
      res.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE

      const appId = process.env.DISCORD_APPLICATION_ID ?? '';

      handleSlashCommand('discord', text, channelId, channelId, '', BASE_URL)
        .then(async (result) => {
          // Follow-up via Discord interactions API
          if (!appId || !token) return;
          const followUp: Record<string, unknown> = { content: result.text };
          if (result.embeds) followUp.embeds = result.embeds;

          await postToDiscordChannel(
            `https://discord.com/api/v10/webhooks/${appId}/${token}`,
            (result.embeds ?? []) as never,
            result.text,
          );
        })
        .catch((e) => logger.warn('Discord command processing failed', { error: String(e) }));

      return;
    }

    res.status(400).json({ error: 'Unknown interaction type' });
  } catch (e) {
    logger.error('Discord endpoint error', { error: String(e) });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /digest/trigger — manual digest trigger (admin) ─────────────────────

const digestTriggerSchema = z.object({
  adminKey: z.string().optional(),
  channelId: z.string().optional(), // only post to a specific channel
});

auditBotRouter.post('/digest/trigger', async (req: Request, res: Response) => {
  try {
    const data = digestTriggerSchema.parse(req.body);
    const envKey = process.env.AUDIT_ADMIN_KEY;
    if (envKey && data.adminKey !== envKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const { sent, failed } = await postDigestNow();

    res.json({
      success: true,
      sent,
      failed,
      message: `Weekly audit digest dispatched to ${sent} channel(s).`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /digest/preview — preview the digest without posting ──────────────────

auditBotRouter.get('/digest/preview', async (_req: Request, res: Response) => {
  try {
    const digest = await buildWeeklyDigest(BASE_URL);
    res.json({
      text: digest.text,
      blocks: digest.blocks,
      embeds: digest.embeds,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /channels — list subscribed channels ──────────────────────────────────

auditBotRouter.get('/channels', async (req: Request, res: Response) => {
  try {
    const platform = req.query.platform as 'slack' | 'discord' | undefined;

    const where: Record<string, unknown> = {
      isActive: true,
      OR: [
        { slackWebhookUrl: { not: null } },
        { userId: { startsWith: 'discord:' } },
        { userId: { startsWith: 'slack:' } },
      ],
    };

    if (platform) {
      where.userId = { startsWith: `${platform}:` };
    }

    const subs = await prismaRead.auditSubscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        contractAddress: true,
        alertTypes: true,
        slackChannel: true,
        cooldownMinutes: true,
        createdAt: true,
      },
    });

    const channels = subs.map((s) => ({
      id: s.id,
      platform: s.userId?.split(':')[0] ?? 'unknown',
      channelId: s.userId?.split(':').slice(1).join(':') ?? '',
      channelName: s.slackChannel ?? null,
      contractAddress: s.contractAddress,
      alertTypes: s.alertTypes,
      cooldownMinutes: s.cooldownMinutes,
      createdAt: s.createdAt,
    }));

    res.json({ count: channels.length, channels });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /channels/:id/unsubscribe — remove a channel subscription ────────────

auditBotRouter.post('/channels/:id/unsubscribe', async (req: Request, res: Response) => {
  try {
    const adminKey = process.env.AUDIT_ADMIN_KEY;
    const provided = req.body?.adminKey as string | undefined;
    if (adminKey && provided !== adminKey) {
      return res.status(403).json({ error: 'Invalid admin key.' });
    }

    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    const { prismaWrite } = await import('../db');
    await prismaWrite.auditSubscription.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
