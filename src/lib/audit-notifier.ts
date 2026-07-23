/**
 * Audit Notification Dispatcher
 *
 * Delivers audit alerts to configured channels (email, webhook, Slack).
 * Called from audit-monitor.ts emitPostAuditAlerts() and audit-pipeline.ts
 * after a certificate is published.
 *
 * Channels:
 *   email   — sends via SMTP (nodemailer if available, else logs to console)
 *   webhook — POST JSON with HMAC-SHA256 signature header
 *   slack   — POST to Slack incoming webhook URL
 *
 * Cooldown: each subscription has a cooldownMinutes window per alertType.
 * A delivery is skipped (not even attempted) if lastTriggeredAt is within
 * that window for the same alertType.
 *
 * Delivery results are persisted in AuditNotificationDelivery for audit trail.
 */

import crypto from 'crypto';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlertType =
  | 'score_drop'
  | 'new_finding'
  | 'upgrade'
  | 'certificate_update'
  | 'certificate_expiry';

export interface NotificationPayload {
  alertType: AlertType;
  contractAddress: string;
  certId?: string;
  version?: number;
  overallScore?: number;
  previousScore?: number;
  scoreDrop?: number;
  riskLevel?: string;
  grade?: string;
  findingSeverity?: string;
  findingTitle?: string;
  findingCount?: number;
  certHash?: string;
  verifyUrl?: string;
  // Expiry-specific fields
  expiresAt?: string;
  daysRemaining?: number;
  urgency?: 'warning' | 'urgent' | 'critical';
  timestamp: string;
  platform: string;
}

// ── HMAC signature for webhooks ───────────────────────────────────────────────

function signWebhookPayload(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── HTTP delivery helper (Axios from existing deps) ───────────────────────────

async function httpPost(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const axios = (await import('axios')).default;
  const json = JSON.stringify(body);

  const response = await axios.post(url, json, {
    headers: { 'Content-Type': 'application/json', ...headers },
    timeout: 10_000,
    validateStatus: () => true, // never throw on HTTP errors
  });

  return {
    status: response.status,
    body: String(response.data).slice(0, 500),
  };
}

// ── Channel dispatchers ───────────────────────────────────────────────────────

async function deliverWebhook(
  payload: NotificationPayload,
  webhookUrl: string,
  secret?: string | null,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  if (secret) {
    headers['X-Audit-Signature'] = signWebhookPayload(body, secret);
    headers['X-Audit-Alert-Type'] = payload.alertType;
    headers['X-Audit-Contract'] = payload.contractAddress;
    headers['X-Audit-Timestamp'] = payload.timestamp;
  }
  return httpPost(webhookUrl, payload as unknown as Record<string, unknown>, headers);
}

async function deliverSlack(
  payload: NotificationPayload,
  slackWebhookUrl: string,
  channel?: string | null,
): Promise<{ status: number; body: string }> {
  const riskEmoji: Record<string, string> = {
    low: '🟢',
    medium: '🟡',
    high: '🟠',
    critical: '🔴',
  };
  const alertEmoji: Record<AlertType, string> = {
    score_drop: '📉',
    new_finding: '🚨',
    upgrade: '⬆️',
    certificate_update: '📋',
    certificate_expiry: '⏰',
  };

  const emoji = alertEmoji[payload.alertType] ?? '🔔';
  const risk = riskEmoji[payload.riskLevel ?? 'medium'] ?? '⚪';
  const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';

  // Build Slack Block Kit message
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Audit Alert — ${payload.alertType.replace(/_/g, ' ').toUpperCase()}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Contract*\n\`${payload.contractAddress.slice(0, 20)}...\`` },
        {
          type: 'mrkdwn',
          text: `*Risk Level*\n${risk} ${(payload.riskLevel ?? 'unknown').toUpperCase()}`,
        },
      ],
    },
  ];

  if (payload.alertType === 'score_drop') {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Previous Score*\n${payload.previousScore ?? '?'}` },
        {
          type: 'mrkdwn',
          text: `*New Score*\n${payload.overallScore ?? '?'} (−${payload.scoreDrop ?? '?'} pts)`,
        },
      ],
    });
  }

  if (payload.alertType === 'new_finding') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Finding*: [${(payload.findingSeverity ?? '').toUpperCase()}] ${payload.findingTitle ?? 'New security finding'}`,
      },
    });
  }

  if (payload.alertType === 'certificate_expiry' && payload.daysRemaining !== undefined) {
    const urgEmoji =
      payload.urgency === 'critical' ? '🔴' : payload.urgency === 'urgent' ? '🟠' : '🟡';
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Days Remaining*\n${urgEmoji} ${payload.daysRemaining} day(s)` },
        { type: 'mrkdwn', text: `*Expires At*\n${payload.expiresAt ?? 'N/A'}` },
      ],
    });
  }

  if (payload.certHash) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Verify Certificate' },
          url: `${baseUrl}/api/v1/audit/verify/${payload.certHash}`,
          style: 'primary',
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_${payload.timestamp} • Soroban Audit Platform_` }],
  });

  const slackBody: Record<string, unknown> = { blocks };
  if (channel) slackBody.channel = channel;

  return httpPost(slackWebhookUrl, slackBody);
}

async function deliverEmail(
  payload: NotificationPayload,
  emailAddress: string,
): Promise<{ status: number; body: string }> {
  // If nodemailer is configured (SMTP_HOST env), use it.
  // Otherwise fall back to a structured log (useful in dev/test).
  const smtpHost = process.env.SMTP_HOST;

  if (!smtpHost) {
    logger.info('Email delivery (SMTP not configured — logged only)', {
      to: emailAddress,
      alertType: payload.alertType,
      contract: payload.contractAddress,
      score: payload.overallScore,
    });
    return { status: 200, body: 'logged' };
  }

  try {
    // Dynamic import — nodemailer is optional
    const nodemailer = (await import('nodemailer' as never)) as {
      createTransport: (opts: unknown) => {
        sendMail: (opts: unknown) => Promise<{ messageId: string }>;
      };
    };

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT ?? '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
    });

    const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';
    const certLink = payload.certHash
      ? `${baseUrl}/api/v1/audit/verify/${payload.certHash}`
      : `${baseUrl}/api/v1/contracts/${payload.contractAddress}/audit`;

    const subject = buildEmailSubject(payload);
    const htmlBody = buildEmailHtml(payload, certLink);
    const textBody = buildEmailText(payload, certLink);

    await transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'audit@soroban.network',
      to: emailAddress,
      subject,
      text: textBody,
      html: htmlBody,
    });

    return { status: 200, body: 'sent' };
  } catch (err) {
    return { status: 500, body: String(err).slice(0, 500) };
  }
}

// ── Email content builders ────────────────────────────────────────────────────

function buildEmailSubject(p: NotificationPayload): string {
  const addr = p.contractAddress.slice(0, 12);
  if (p.alertType === 'score_drop')
    return `[Audit Alert] Score dropped ${p.scoreDrop ?? '?'} pts — ${addr}...`;
  if (p.alertType === 'new_finding')
    return `[Audit Alert] New ${p.findingSeverity ?? 'security'} finding — ${addr}...`;
  if (p.alertType === 'upgrade') return `[Audit Alert] Contract upgrade detected — ${addr}...`;
  if (p.alertType === 'certificate_expiry')
    return `[Audit Alert] Certificate expires in ${p.daysRemaining ?? '?'} day(s) — ${addr}...`;
  return `[Audit Alert] Certificate updated — ${addr}... (v${p.version ?? '?'})`;
}

function buildEmailText(p: NotificationPayload, certLink: string): string {
  return [
    `SOROBAN SMART CONTRACT AUDIT ALERT`,
    `===================================`,
    `Alert Type   : ${p.alertType.replace(/_/g, ' ').toUpperCase()}`,
    `Contract     : ${p.contractAddress}`,
    `Risk Level   : ${(p.riskLevel ?? 'unknown').toUpperCase()}`,
    p.overallScore !== undefined ? `Score        : ${p.overallScore}/100 (${p.grade ?? ''})` : '',
    p.previousScore !== undefined ? `Previous     : ${p.previousScore}/100` : '',
    p.scoreDrop !== undefined ? `Drop         : −${p.scoreDrop} points` : '',
    p.findingSeverity
      ? `Finding      : [${p.findingSeverity.toUpperCase()}] ${p.findingTitle ?? ''}`
      : '',
    p.daysRemaining !== undefined
      ? `Expires In   : ${p.daysRemaining} day(s) (${p.expiresAt ?? ''})`
      : '',
    p.urgency ? `Urgency      : ${p.urgency.toUpperCase()}` : '',
    `Time         : ${p.timestamp}`,
    ``,
    `View Certificate: ${certLink}`,
    ``,
    `-- Soroban Audit Platform`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildEmailHtml(p: NotificationPayload, certLink: string): string {
  const riskColors: Record<string, string> = {
    low: '#22c55e',
    medium: '#eab308',
    high: '#ef4444',
    critical: '#7f1d1d',
  };
  const urgencyColors: Record<string, string> = {
    warning: '#eab308',
    urgent: '#ef4444',
    critical: '#7f1d1d',
  };
  const alertColor =
    p.alertType === 'certificate_expiry'
      ? (urgencyColors[p.urgency ?? 'warning'] ?? '#eab308')
      : (riskColors[p.riskLevel ?? 'medium'] ?? '#6b7280');
  const addrShort = `${p.contractAddress.slice(0, 16)}...`;

  return `<!DOCTYPE html><html><body style="font-family:Helvetica,sans-serif;background:#f9fafb;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;border-left:4px solid ${alertColor}">
  <h2 style="margin:0 0 8px;color:#111">🔔 Audit Alert</h2>
  <p style="color:#6b7280;font-size:13px;margin:0 0 24px">${p.alertType.replace(/_/g, ' ').toUpperCase()} · ${p.timestamp}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:6px 0;color:#6b7280">Contract</td><td style="font-family:monospace">${addrShort}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Risk Level</td><td style="color:${alertColor};font-weight:bold">${(p.riskLevel ?? 'unknown').toUpperCase()}</td></tr>
    ${p.overallScore !== undefined ? `<tr><td style="padding:6px 0;color:#6b7280">Score</td><td>${p.overallScore}/100 (Grade ${p.grade ?? '?'})</td></tr>` : ''}
    ${p.previousScore !== undefined ? `<tr><td style="padding:6px 0;color:#6b7280">Previous Score</td><td>${p.previousScore}/100</td></tr>` : ''}
    ${p.scoreDrop !== undefined ? `<tr><td style="padding:6px 0;color:#6b7280">Score Drop</td><td style="color:#ef4444">−${p.scoreDrop} points</td></tr>` : ''}
    ${p.findingSeverity ? `<tr><td style="padding:6px 0;color:#6b7280">Finding</td><td>[${p.findingSeverity.toUpperCase()}] ${p.findingTitle ?? ''}</td></tr>` : ''}
    ${p.daysRemaining !== undefined ? `<tr><td style="padding:6px 0;color:#6b7280">Expires In</td><td style="color:${alertColor};font-weight:bold">${p.daysRemaining} day(s)</td></tr>` : ''}
    ${p.expiresAt ? `<tr><td style="padding:6px 0;color:#6b7280">Expiry Date</td><td>${p.expiresAt}</td></tr>` : ''}
  </table>
  <div style="margin-top:24px">
    <a href="${certLink}" style="background:#1e40af;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px">${p.alertType === 'certificate_expiry' ? 'Renew Certificate →' : 'View Certificate →'}</a>
  </div>
  <p style="color:#9ca3af;font-size:12px;margin-top:24px">Soroban Smart Block Explorer · Audit Platform</p>
</div></body></html>`;
}

// ── Core dispatcher ───────────────────────────────────────────────────────────

/**
 * Deliver a notification to ALL active subscriptions matching the given
 * contractAddress + alertType, respecting cooldown windows.
 *
 * Persists a delivery record for every attempt (success or failure).
 * Never throws — failures are logged and recorded but don't block callers.
 */
export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  const subs = await prismaRead.auditSubscription.findMany({
    where: {
      contractAddress: payload.contractAddress,
      isActive: true,
      alertTypes: { has: payload.alertType },
    },
  });

  if (subs.length === 0) return;

  const now = new Date();

  for (const sub of subs) {
    // ── Cooldown check ────────────────────────────────────────────────────
    if (sub.lastTriggeredAt) {
      const cooldownMs = (sub.cooldownMinutes ?? 60) * 60_000;
      if (now.getTime() - sub.lastTriggeredAt.getTime() < cooldownMs) {
        logger.debug('Audit notification skipped (cooldown)', {
          subId: sub.id,
          alertType: payload.alertType,
        });
        continue;
      }
    }

    // ── score_drop threshold check ────────────────────────────────────────
    if (payload.alertType === 'score_drop' && sub.threshold !== null) {
      const drop = payload.scoreDrop ?? 0;
      if (drop < (sub.threshold ?? 10)) continue;
    }

    // ── Determine which channels to fire ─────────────────────────────────
    const channels: Array<{
      channel: string;
      deliver: () => Promise<{ status: number; body: string }>;
    }> = [];

    if (sub.webhookUrl) {
      channels.push({
        channel: 'webhook',
        deliver: () => deliverWebhook(payload, sub.webhookUrl!, sub.webhookSecret),
      });
    }
    if (sub.slackWebhookUrl) {
      channels.push({
        channel: 'slack',
        deliver: () => deliverSlack(payload, sub.slackWebhookUrl!, sub.slackChannel),
      });
    }
    if (sub.emailAddress) {
      channels.push({
        channel: 'email',
        deliver: () => deliverEmail(payload, sub.emailAddress!),
      });
    }

    if (channels.length === 0) {
      // No delivery channel configured — WS-only subscriber
      continue;
    }

    // ── Dispatch to each channel ──────────────────────────────────────────
    for (const ch of channels) {
      let status = 0,
        body = '',
        errorMsg = '';
      let delivered = false;

      try {
        const result = await ch.deliver();
        status = result.status;
        body = result.body;
        delivered = status >= 200 && status < 300;
        if (!delivered) errorMsg = `HTTP ${status}: ${body.slice(0, 200)}`;
      } catch (err) {
        errorMsg = String(err).slice(0, 500);
        status = 0;
      }

      // Persist delivery record
      await prismaWrite.auditNotificationDelivery
        .create({
          data: {
            subscriptionId: sub.id,
            alertType: payload.alertType,
            channel: ch.channel,
            status: delivered ? 'success' : 'failed',
            payload: payload as unknown as import('@prisma/client').Prisma.InputJsonValue,
            httpStatus: status || null,
            responseBody: body || null,
            errorMsg: errorMsg || null,
            deliveredAt: delivered ? now : null,
          },
        })
        .catch((e) => logger.warn('Failed to persist delivery record', { error: String(e) }));

      logger.info('Audit notification dispatched', {
        subId: sub.id,
        channel: ch.channel,
        alertType: payload.alertType,
        contract: payload.contractAddress,
        success: delivered,
      });
    }

    // Update lastTriggeredAt to enforce cooldown
    await prismaWrite.auditSubscription
      .update({
        where: { id: sub.id },
        data: { lastTriggeredAt: now },
      })
      .catch(() => {
        /* non-fatal */
      });
  }
}

// ── Convenience wrappers (called from audit-monitor / audit-pipeline) ─────────

export async function notifyScoreDrop(
  contractAddress: string,
  certId: string,
  version: number,
  previousScore: number,
  newScore: number,
  certHash: string,
): Promise<void> {
  const grade =
    newScore >= 85 ? 'A' : newScore >= 70 ? 'B' : newScore >= 55 ? 'C' : newScore >= 40 ? 'D' : 'F';
  const riskLevel =
    newScore >= 85 ? 'low' : newScore >= 70 ? 'medium' : newScore >= 55 ? 'high' : 'critical';

  await dispatchNotification({
    alertType: 'score_drop',
    contractAddress,
    certId,
    version,
    overallScore: newScore,
    previousScore,
    scoreDrop: previousScore - newScore,
    grade,
    riskLevel,
    certHash,
    verifyUrl: `/api/v1/audit/verify/${certId}`,
    timestamp: new Date().toISOString(),
    platform: 'Soroban Audit Platform',
  });
}

export async function notifyNewFinding(
  contractAddress: string,
  certId: string,
  findingSeverity: string,
  findingTitle: string,
  findingCount: number,
  certHash: string,
): Promise<void> {
  await dispatchNotification({
    alertType: 'new_finding',
    contractAddress,
    certId,
    findingSeverity,
    findingTitle,
    findingCount,
    certHash,
    verifyUrl: `/api/v1/audit/verify/${certId}`,
    timestamp: new Date().toISOString(),
    platform: 'Soroban Audit Platform',
  });
}

export async function notifyUpgrade(
  contractAddress: string,
  certId: string,
  version: number,
  overallScore: number,
  certHash: string,
): Promise<void> {
  const grade =
    overallScore >= 85
      ? 'A'
      : overallScore >= 70
        ? 'B'
        : overallScore >= 55
          ? 'C'
          : overallScore >= 40
            ? 'D'
            : 'F';
  const riskLevel =
    overallScore >= 85
      ? 'low'
      : overallScore >= 70
        ? 'medium'
        : overallScore >= 55
          ? 'high'
          : 'critical';

  await dispatchNotification({
    alertType: 'upgrade',
    contractAddress,
    certId,
    version,
    overallScore,
    grade,
    riskLevel,
    certHash,
    verifyUrl: `/api/v1/audit/verify/${certId}`,
    timestamp: new Date().toISOString(),
    platform: 'Soroban Audit Platform',
  });
}

export async function notifyCertificateUpdate(
  contractAddress: string,
  certId: string,
  version: number,
  overallScore: number,
  certHash: string,
  trigger: string,
): Promise<void> {
  const grade =
    overallScore >= 85
      ? 'A'
      : overallScore >= 70
        ? 'B'
        : overallScore >= 55
          ? 'C'
          : overallScore >= 40
            ? 'D'
            : 'F';
  const riskLevel =
    overallScore >= 85
      ? 'low'
      : overallScore >= 70
        ? 'medium'
        : overallScore >= 55
          ? 'high'
          : 'critical';

  await dispatchNotification({
    alertType: 'certificate_update',
    contractAddress,
    certId,
    version,
    overallScore,
    grade,
    riskLevel,
    certHash,
    verifyUrl: `/api/v1/audit/verify/${certId}`,
    timestamp: new Date().toISOString(),
    platform: `Soroban Audit Platform (trigger: ${trigger})`,
  });
}

export async function notifyCertificateExpiry(
  contractAddress: string,
  certId: string,
  version: number,
  overallScore: number,
  certHash: string,
  expiresAt: Date,
  daysRemaining: number,
): Promise<void> {
  const urgency: 'warning' | 'urgent' | 'critical' =
    daysRemaining <= 7 ? 'critical' : daysRemaining <= 14 ? 'urgent' : 'warning';

  const grade =
    overallScore >= 85
      ? 'A'
      : overallScore >= 70
        ? 'B'
        : overallScore >= 55
          ? 'C'
          : overallScore >= 40
            ? 'D'
            : 'F';
  const riskLevel =
    overallScore >= 85
      ? 'low'
      : overallScore >= 70
        ? 'medium'
        : overallScore >= 55
          ? 'high'
          : 'critical';

  await dispatchNotification({
    alertType: 'certificate_expiry',
    contractAddress,
    certId,
    version,
    overallScore,
    grade,
    riskLevel,
    certHash,
    expiresAt: expiresAt.toISOString(),
    daysRemaining,
    urgency,
    verifyUrl: `/api/v1/audit/verify/${certId}`,
    timestamp: new Date().toISOString(),
    platform: 'Soroban Audit Platform',
  });
}
