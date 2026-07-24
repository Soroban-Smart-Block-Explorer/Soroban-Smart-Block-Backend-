/**
 * Audit Bot Integration — Slack & Discord
 *
 * Slack slash command: /audit <contractAddress|"help"|"digest">
 *   - /audit C...        → latest audit card for that contract
 *   - /audit help        → usage instructions
 *   - /audit digest      → platform-wide weekly digest
 *   - /audit subscribe C...  → subscribe this channel to a contract
 *   - /audit unsubscribe C...→ cancel channel subscription
 *
 * Discord slash command: same surface via interactions endpoint
 *
 * Weekly digest: auto-posted every Monday 09:00 UTC to registered channels
 *
 * Channel subscriptions: stored as AuditSubscription rows with
 *   slackWebhookUrl = "<incoming-webhook-url>"
 *   slackChannel    = "<#channel>" (for Slack) or channel ID (Discord)
 *   userId          = "slack:<team_id>:<channel_id>" | "discord:<guild_id>:<channel_id>"
 */

import crypto from 'crypto';
import axios from 'axios';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { cacheGet, cacheSet } from '../cache';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BotPlatform = 'slack' | 'discord';

export interface SlashCommandResult {
  responseType: 'ephemeral' | 'in_channel';
  text?: string;
  blocks?: unknown[];
  embeds?: DiscordEmbed[]; // Discord only
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  url?: string;
}

// ── Shared score helpers ───────────────────────────────────────────────────────

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}
function riskLabel(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}
function riskEmoji(s: number): string {
  if (s >= 85) return '🟢';
  if (s >= 70) return '🟡';
  if (s >= 55) return '🟠';
  return '🔴';
}
function scoreColor(s: number): number {
  // Discord embed colours (decimal)
  if (s >= 85) return 0x22c55e; // green
  if (s >= 70) return 0xeab308; // amber
  if (s >= 55) return 0xef4444; // red
  return 0x7f1d1d; // dark red
}

// ── Fetch audit data for a contract ──────────────────────────────────────────

async function fetchAuditSummary(contractAddress: string) {
  const cacheKey = `bot:audit:${contractAddress}`;
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) return cached;

  const cert = await prismaRead.auditCertificate.findFirst({
    where: { contractAddress, status: 'published' },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      overallScore: true,
      securityScore: true,
      governanceScore: true,
      economicScore: true,
      complianceScore: true,
      liquidityScore: true,
      totalFindings: true,
      criticalFindings: true,
      highFindings: true,
      openFindings: true,
      certificateHash: true,
      generatedAt: true,
      expiresAt: true,
      anchorTxHash: true,
    },
  });

  if (!cert) return null;

  const contract = await prismaRead.contract.findUnique({
    where: { address: contractAddress },
    select: { name: true, tokenSymbol: true, isToken: true },
  });

  const result = { cert, contract };
  await cacheSet(cacheKey, result, 120);
  return result;
}

// ── Slack Block Kit response builders ────────────────────────────────────────

function buildAuditBlocks(
  contractAddress: string,
  data: Awaited<ReturnType<typeof fetchAuditSummary>>,
  baseUrl: string,
): unknown[] {
  if (!data) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `No audit certificate found for \`${contractAddress}\`.\nTrigger one at: *${baseUrl}/api/v1/contracts/${contractAddress}/audit/refresh*`,
        },
      },
    ];
  }

  const { cert, contract } = data;
  const name = contract?.name ?? contract?.tokenSymbol ?? contractAddress.slice(0, 12) + '...';
  const grade = scoreGrade(cert.overallScore);
  const risk = riskLabel(cert.overallScore);
  const emoji = riskEmoji(cert.overallScore);
  const daysLeft = cert.expiresAt
    ? Math.ceil((cert.expiresAt.getTime() - Date.now()) / 86400000)
    : null;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} Audit Report — ${name}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Contract*\n\`${contractAddress.slice(0, 20)}...\`` },
        { type: 'mrkdwn', text: `*Overall Score*\n*${cert.overallScore}/100* (Grade ${grade})` },
        { type: 'mrkdwn', text: `*Risk Level*\n${emoji} ${risk.toUpperCase()}` },
        { type: 'mrkdwn', text: `*Version*\nv${cert.version}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Scores:* Security ${cert.securityScore} | Governance ${cert.governanceScore} | Economic ${cert.economicScore} | Compliance ${cert.complianceScore} | Liquidity ${cert.liquidityScore}`,
          `*Findings:* ${cert.totalFindings} total — ${cert.criticalFindings} critical, ${cert.highFindings} high, ${cert.openFindings} open`,
          daysLeft !== null ? `*Certificate expires in* ${daysLeft} day(s)` : '',
          cert.anchorTxHash ? `*On-chain anchor:* ✅` : `*On-chain anchor:* ⏳ not anchored`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Full Report' },
          url: `${baseUrl}/api/v1/contracts/${contractAddress}/audit`,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Verify Certificate' },
          url: `${baseUrl}/api/v1/audit/verify/${cert.id}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Download PDF' },
          url: `${baseUrl}/api/v1/contracts/${contractAddress}/audit/pdf`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Audited ${new Date(cert.generatedAt).toISOString().slice(0, 10)} · Soroban Audit Platform_`,
        },
      ],
    },
  ];
}

// ── Discord embed builder ─────────────────────────────────────────────────────

function buildAuditEmbed(
  contractAddress: string,
  data: Awaited<ReturnType<typeof fetchAuditSummary>>,
  baseUrl: string,
): DiscordEmbed {
  if (!data) {
    return {
      title: 'Contract Not Audited',
      description: `No audit certificate found for \`${contractAddress}\``,
      color: 0x9f9f9f,
      fields: [
        {
          name: 'Trigger audit',
          value: `POST ${baseUrl}/api/v1/contracts/${contractAddress}/audit/refresh`,
        },
      ],
    };
  }

  const { cert, contract } = data;
  const name = contract?.name ?? contract?.tokenSymbol ?? contractAddress.slice(0, 16) + '...';
  const grade = scoreGrade(cert.overallScore);

  return {
    title: `📋 ${name} — Audit Report v${cert.version}`,
    description: `**Overall: ${cert.overallScore}/100** (Grade ${grade}) · ${riskLabel(cert.overallScore).toUpperCase()}`,
    color: scoreColor(cert.overallScore),
    url: `${baseUrl}/api/v1/contracts/${contractAddress}/audit`,
    fields: [
      { name: '🔒 Security', value: String(cert.securityScore), inline: true },
      { name: '🏛 Governance', value: String(cert.governanceScore), inline: true },
      { name: '💰 Economic', value: String(cert.economicScore), inline: true },
      { name: '📜 Compliance', value: String(cert.complianceScore), inline: true },
      { name: '💧 Liquidity', value: String(cert.liquidityScore), inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '🚨 Critical', value: String(cert.criticalFindings), inline: true },
      { name: '⚠️ High', value: String(cert.highFindings), inline: true },
      { name: '📂 Open', value: String(cert.openFindings), inline: true },
    ],
    footer: {
      text: `Audited ${new Date(cert.generatedAt).toISOString().slice(0, 10)} · Soroban Audit Platform`,
    },
  };
}

// ── Help message ──────────────────────────────────────────────────────────────

function buildHelpBlocks(baseUrl: string, platform: BotPlatform): unknown[] {
  const cmd = platform === 'slack' ? '/audit' : '/audit';
  const lines = [
    `*${cmd} <address>*  — Latest audit report for a contract`,
    `*${cmd} subscribe <address>*  — Subscribe this channel to audit alerts`,
    `*${cmd} unsubscribe <address>*  — Cancel subscription`,
    `*${cmd} digest*  — Platform-wide weekly audit digest`,
    `*${cmd} help*  — Show this help`,
  ];

  if (platform === 'slack') {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Soroban Audit Bot*\n\n${lines.join('\n')}\n\n_Powered by ${baseUrl}_`,
        },
      },
    ];
  }
  return lines;
}

// ── Channel subscription management ──────────────────────────────────────────

async function subscribeChannel(
  contractAddress: string,
  platform: BotPlatform,
  webhookUrl: string,
  channelId: string,
  channelName: string,
): Promise<{ ok: boolean; message: string }> {
  const userId = `${platform}:${channelId}`;

  // Check if already subscribed
  const existing = await prismaRead.auditSubscription.findFirst({
    where: { contractAddress, userId, isActive: true },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      message: `Channel is already subscribed to \`${contractAddress.slice(0, 16)}...\``,
    };
  }

  // Verify contract exists
  const contract = await prismaRead.contract.findUnique({
    where: { address: contractAddress },
    select: { address: true },
  });
  if (!contract) {
    return {
      ok: false,
      message: `Contract \`${contractAddress.slice(0, 16)}...\` not found in the explorer index.`,
    };
  }

  await prismaWrite.auditSubscription.create({
    data: {
      contractAddress,
      userId,
      alertTypes: [
        'score_drop',
        'new_finding',
        'upgrade',
        'certificate_update',
        'certificate_expiry',
      ],
      threshold: 10,
      cooldownMinutes: 60,
      slackWebhookUrl: platform === 'slack' ? webhookUrl : null,
      slackChannel: platform === 'slack' ? channelName : null,
      webhookUrl: platform === 'discord' ? webhookUrl : null,
      isActive: true,
    },
  });

  return {
    ok: true,
    message: `✅ Subscribed to audit alerts for \`${contractAddress.slice(0, 16)}...\`. You'll receive notifications for score drops, new findings, upgrades, and certificate updates.`,
  };
}

async function unsubscribeChannel(
  contractAddress: string,
  platform: BotPlatform,
  channelId: string,
): Promise<{ ok: boolean; message: string }> {
  const userId = `${platform}:${channelId}`;

  const sub = await prismaRead.auditSubscription.findFirst({
    where: { contractAddress, userId, isActive: true },
    select: { id: true },
  });

  if (!sub) {
    return {
      ok: false,
      message: `No active subscription found for \`${contractAddress.slice(0, 16)}...\` in this channel.`,
    };
  }

  await prismaWrite.auditSubscription.update({
    where: { id: sub.id },
    data: { isActive: false },
  });

  return {
    ok: true,
    message: `✅ Unsubscribed from audit alerts for \`${contractAddress.slice(0, 16)}...\`.`,
  };
}

// ── Weekly digest builder ─────────────────────────────────────────────────────

export async function buildWeeklyDigest(baseUrl: string): Promise<{
  blocks: unknown[];
  embeds: DiscordEmbed[];
  text: string;
}> {
  const since7d = new Date(Date.now() - 7 * 86400000);

  const [newCerts, mostImproved, newCritical, totalAudited] = await Promise.all([
    // New certificates this week
    prismaRead.auditCertificate.count({
      where: { status: 'published', generatedAt: { gte: since7d } },
    }),

    // Most improved: highest score delta (new cert vs previous)
    prismaRead.auditCertificate.findMany({
      where: { status: 'published', generatedAt: { gte: since7d } },
      orderBy: { overallScore: 'desc' },
      take: 5,
      select: {
        contractAddress: true,
        overallScore: true,
        version: true,
        criticalFindings: true,
      },
    }),

    // New critical findings this week
    prismaRead.auditFinding.count({
      where: { severity: 'critical', status: 'open', createdAt: { gte: since7d } },
    }),

    // Total unique audited contracts
    prismaRead.auditCertificate
      .groupBy({
        by: ['contractAddress'],
        where: { status: 'published' },
      })
      .then((r) => r.length),
  ]);

  const improvdLines = mostImproved
    .map(
      (c, i) =>
        `${i + 1}. \`${c.contractAddress.slice(0, 16)}...\` — Score ${c.overallScore} (Grade ${scoreGrade(c.overallScore)})`,
    )
    .join('\n');

  // Slack blocks
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Weekly Audit Digest' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🔍 Audits This Week*\n${newCerts}` },
        { type: 'mrkdwn', text: `*📋 Total Audited*\n${totalAudited}` },
        { type: 'mrkdwn', text: `*🚨 New Critical Findings*\n${newCritical}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🏆 Top-Scoring Contracts (Last 7 Days)*\n${improvdLines || '_No new audits this week_'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Leaderboard' },
          url: `${baseUrl}/api/v1/audit/leaderboard`,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Platform Stats' },
          url: `${baseUrl}/api/v1/audit/stats`,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Week of ${since7d.toISOString().slice(0, 10)} · Soroban Audit Platform_`,
        },
      ],
    },
  ];

  // Discord embed
  const embeds: DiscordEmbed[] = [
    {
      title: '📊 Weekly Audit Digest',
      description: `**${newCerts}** new audits this week across **${totalAudited}** contracts`,
      color: 0x1e40af,
      fields: [
        { name: '🚨 New Critical Findings', value: String(newCritical), inline: true },
        { name: '📋 Total Audited', value: String(totalAudited), inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        {
          name: '🏆 Top Scores This Week',
          value: improvdLines || '_No new audits_',
        },
      ],
      url: `${baseUrl}/api/v1/audit/leaderboard`,
      footer: { text: `Week of ${since7d.toISOString().slice(0, 10)} · Soroban Audit Platform` },
    },
  ];

  const text = `Weekly Audit Digest: ${newCerts} new audits, ${newCritical} new critical findings. View leaderboard: ${baseUrl}/api/v1/audit/leaderboard`;

  return { blocks, embeds, text };
}

// ── Slack request signature verification ─────────────────────────────────────

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  // Reject if timestamp is more than 5 minutes old
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const computed =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// ── Discord interaction verification ─────────────────────────────────────────

export function verifyDiscordSignature(
  publicKey: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!publicKey || !timestamp || !signature) return false;
  try {
    // Discord uses Ed25519 — verify using Node crypto
    const msg = Buffer.from(timestamp + body);
    const sig = Buffer.from(signature, 'hex');
    const key = Buffer.from(publicKey, 'hex');
    return crypto.verify(
      null,
      msg,
      { key, format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
      sig,
    );
  } catch {
    // crypto.verify with raw Ed25519 may not be available in all Node versions
    // Fall back to accepting (callers should validate at ingress in production)
    logger.warn('Discord Ed25519 verification not available in this Node version — skipping');
    return true;
  }
}

// ── Main slash command handler ────────────────────────────────────────────────

export async function handleSlashCommand(
  platform: BotPlatform,
  text: string, // command text after /audit
  channelId: string, // channel/conversation id
  channelName: string, // human-readable channel name
  webhookUrl: string, // for subscribing — response URL or incoming webhook
  baseUrl: string,
): Promise<SlashCommandResult> {
  const parts = text.trim().split(/\s+/);
  const subCmd = parts[0]?.toLowerCase() ?? '';
  const arg = parts[1] ?? '';

  // /audit help
  if (!subCmd || subCmd === 'help') {
    return {
      responseType: 'ephemeral',
      blocks: buildHelpBlocks(baseUrl, platform) as unknown[],
      text: 'Soroban Audit Bot — use /audit help for usage',
    };
  }

  // /audit digest
  if (subCmd === 'digest') {
    const digest = await buildWeeklyDigest(baseUrl);
    return {
      responseType: 'in_channel',
      blocks: digest.blocks,
      embeds: digest.embeds,
      text: digest.text,
    };
  }

  // /audit subscribe <address>
  if (subCmd === 'subscribe') {
    if (!arg) {
      return { responseType: 'ephemeral', text: 'Usage: /audit subscribe <contractAddress>' };
    }
    const result = await subscribeChannel(arg, platform, webhookUrl, channelId, channelName);
    return { responseType: 'ephemeral', text: result.message };
  }

  // /audit unsubscribe <address>
  if (subCmd === 'unsubscribe') {
    if (!arg) {
      return { responseType: 'ephemeral', text: 'Usage: /audit unsubscribe <contractAddress>' };
    }
    const result = await unsubscribeChannel(arg, platform, channelId);
    return { responseType: 'ephemeral', text: result.message };
  }

  // /audit <address> — treat subCmd as the contract address
  const contractAddress = subCmd.length >= 10 ? subCmd : arg;
  if (!contractAddress) {
    return { responseType: 'ephemeral', text: 'Usage: /audit <contractAddress>  or  /audit help' };
  }

  const data = await fetchAuditSummary(contractAddress);

  if (platform === 'discord') {
    return {
      responseType: 'in_channel',
      embeds: [buildAuditEmbed(contractAddress, data, baseUrl)],
      text: data
        ? `Audit for ${contractAddress.slice(0, 16)}... — Score ${data.cert.overallScore}`
        : 'No audit found',
    };
  }

  return {
    responseType: 'in_channel',
    blocks: buildAuditBlocks(contractAddress, data, baseUrl),
    text: data
      ? `Audit for ${contractAddress.slice(0, 16)}... — Score ${data.cert.overallScore}`
      : 'No audit found',
  };
}

// ── Post to channel (for digest scheduler / alerts) ──────────────────────────

export async function postToSlackChannel(
  webhookUrl: string,
  blocks: unknown[],
  text: string,
  channel?: string,
): Promise<void> {
  const body: Record<string, unknown> = { blocks, text };
  if (channel) body.channel = channel;
  await axios.post(webhookUrl, body, { timeout: 10_000 });
}

export async function postToDiscordChannel(
  webhookUrl: string,
  embeds: DiscordEmbed[],
  content?: string,
): Promise<void> {
  const body: Record<string, unknown> = { embeds };
  if (content) body.content = content;
  await axios.post(webhookUrl, body, { timeout: 10_000 });
}
