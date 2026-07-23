/**
 * Incident Dispatcher — PagerDuty & Opsgenie
 *
 * Fires a P1/P2 incident for three audit-specific triggers:
 *
 *   CRITICAL_FINDING_HIGH_TVL
 *     A new critical finding is discovered in a contract with TVL > $1 M.
 *     PagerDuty severity: critical  |  Opsgenie priority: P1
 *
 *   SCORE_BELOW_THRESHOLD
 *     A contract's overall audit score drops below CRITICAL_SCORE_THRESHOLD (30).
 *     PagerDuty severity: critical  |  Opsgenie priority: P1
 *
 *   CERT_SIGNATURE_FAILURE
 *     Certificate signature verification fails during a public /verify call.
 *     PagerDuty severity: error     |  Opsgenie priority: P2
 *
 * Both platforms are tried if configured; failure on one does not block the other.
 * Incidents are deduplicated by dedup key (certId/contractAddress + triggerType).
 * A DB row is written for every attempt so the audit trail is complete.
 *
 * Required env vars (at least one platform must be configured):
 *   PAGERDUTY_ROUTING_KEY    — PagerDuty Events API v2 integration key
 *   OPSGENIE_API_KEY         — Opsgenie Alert API key
 *   OPSGENIE_REGION          — "us" (default) | "eu"
 *   INCIDENT_TVL_THRESHOLD   — TVL USD threshold for critical finding alert (default 1000000)
 *   CRITICAL_SCORE_THRESHOLD — Overall score below which a P1 is fired (default 30)
 */

import crypto from 'crypto';
import axios from 'axios';
import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

// ── Configuration ─────────────────────────────────────────────────────────────

const PD_ROUTING_KEY = () => process.env.PAGERDUTY_ROUTING_KEY ?? '';
const OG_API_KEY = () => process.env.OPSGENIE_API_KEY ?? '';
const OG_REGION = () => process.env.OPSGENIE_REGION ?? 'us';
const TVL_THRESHOLD = parseFloat(process.env.INCIDENT_TVL_THRESHOLD ?? '1000000');
const SCORE_THRESHOLD = parseInt(process.env.CRITICAL_SCORE_THRESHOLD ?? '30');

const PD_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
const OG_ALERT_URL = (region: string) =>
  region === 'eu' ? 'https://api.eu.opsgenie.com/v2/alerts' : 'https://api.opsgenie.com/v2/alerts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type IncidentTrigger =
  | 'CRITICAL_FINDING_HIGH_TVL'
  | 'SCORE_BELOW_THRESHOLD'
  | 'CERT_SIGNATURE_FAILURE';

export interface IncidentContext {
  trigger: IncidentTrigger;
  contractAddress: string;
  certId?: string;
  certHash?: string;
  overallScore?: number;
  tvlUsd?: number;
  findingId?: string;
  findingTitle?: string;
  findingSeverity?: string;
  detail?: string;
}

export interface DispatchResult {
  trigger: IncidentTrigger;
  contractAddress: string;
  pagerduty: ChannelResult;
  opsgenie: ChannelResult;
  dedupKey: string;
  alreadyOpen: boolean;
}

interface ChannelResult {
  sent: boolean;
  skipped: boolean; // true when not configured
  dedupId: string | null;
  error: string | null;
}

// ── Dedup key generation ──────────────────────────────────────────────────────

function buildDedupKey(ctx: IncidentContext): string {
  const base = `${ctx.trigger}:${ctx.contractAddress}:${ctx.certId ?? ctx.certHash ?? ''}`;
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

// ── TVL helper ────────────────────────────────────────────────────────────────

async function getContractTvlUsd(contractAddress: string): Promise<number> {
  const [yield_, portfolio] = await Promise.all([
    prismaRead.yieldOpportunity.findFirst({
      where: { contractAddress },
      orderBy: { updatedAt: 'desc' },
      select: { tvl: true },
    }),
    prismaRead.portfolioSnapshot.findFirst({
      where: { contractAddress },
      orderBy: { snapshotAt: 'desc' },
      select: { valueUsd: true },
    }),
  ]);
  if (yield_?.tvl) {
    const v = parseFloat(yield_.tvl);
    if (!isNaN(v) && v > 0) return v;
  }
  return portfolio?.valueUsd ?? 0;
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildSummary(ctx: IncidentContext): string {
  const addr = ctx.contractAddress.slice(0, 16) + '...';
  switch (ctx.trigger) {
    case 'CRITICAL_FINDING_HIGH_TVL':
      return `[CRITICAL] New critical finding in high-TVL contract ${addr} — ${ctx.findingTitle ?? 'security vulnerability'}`;
    case 'SCORE_BELOW_THRESHOLD':
      return `[CRITICAL] Audit score dropped to ${ctx.overallScore}/100 for contract ${addr} (threshold: ${SCORE_THRESHOLD})`;
    case 'CERT_SIGNATURE_FAILURE':
      return `[ERROR] Certificate signature verification failed for contract ${addr}`;
  }
}

function buildDetails(ctx: IncidentContext): Record<string, unknown> {
  const baseUrl = process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network';
  return {
    trigger: ctx.trigger,
    contractAddress: ctx.contractAddress,
    certId: ctx.certId ?? null,
    certHash: ctx.certHash ?? null,
    overallScore: ctx.overallScore ?? null,
    tvlUsd: ctx.tvlUsd ?? null,
    findingId: ctx.findingId ?? null,
    findingTitle: ctx.findingTitle ?? null,
    findingSeverity: ctx.findingSeverity ?? null,
    detail: ctx.detail ?? null,
    auditUrl: `${baseUrl}/api/v1/contracts/${ctx.contractAddress}/audit`,
    verifyUrl: ctx.certId ? `${baseUrl}/api/v1/audit/verify/${ctx.certId}` : null,
    platform: 'Soroban Audit Platform',
  };
}

// ── PagerDuty Events API v2 ───────────────────────────────────────────────────

async function firePagerDuty(ctx: IncidentContext, dedupKey: string): Promise<ChannelResult> {
  const routingKey = PD_ROUTING_KEY();
  if (!routingKey) {
    return { sent: false, skipped: true, dedupId: null, error: null };
  }

  // PagerDuty severity mapping
  const severity = ctx.trigger === 'CERT_SIGNATURE_FAILURE' ? 'error' : 'critical';
  const component = `soroban-audit:${ctx.contractAddress.slice(0, 16)}`;

  const payload = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: buildSummary(ctx),
      severity,
      source: 'soroban-explorer-audit-platform',
      component,
      group: 'smart-contract-audit',
      class: ctx.trigger,
      custom_details: buildDetails(ctx),
    },
    links: [
      {
        href: `${process.env.PUBLIC_API_BASE_URL ?? 'https://explorer.soroban.network'}/api/v1/contracts/${ctx.contractAddress}/audit`,
        text: 'Audit Report',
      },
    ],
  };

  try {
    const resp = await axios.post(PD_EVENTS_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    const dedupId = (resp.data as { dedup_key?: string })?.dedup_key ?? dedupKey;
    logger.info('PagerDuty incident fired', { trigger: ctx.trigger, dedupId });
    return { sent: true, skipped: false, dedupId, error: null };
  } catch (err) {
    const msg = String(err);
    logger.error('PagerDuty dispatch failed', { trigger: ctx.trigger, error: msg });
    return { sent: false, skipped: false, dedupId: null, error: msg.slice(0, 500) };
  }
}

// ── Opsgenie Alert API ────────────────────────────────────────────────────────

async function fireOpsgenie(ctx: IncidentContext, dedupKey: string): Promise<ChannelResult> {
  const apiKey = OG_API_KEY();
  if (!apiKey) {
    return { sent: false, skipped: true, dedupId: null, error: null };
  }

  // Opsgenie priority mapping
  const priority = ctx.trigger === 'CERT_SIGNATURE_FAILURE' ? 'P2' : 'P1';

  const tagMap: Record<IncidentTrigger, string[]> = {
    CRITICAL_FINDING_HIGH_TVL: ['critical', 'high-tvl', 'security', 'soroban-audit'],
    SCORE_BELOW_THRESHOLD: ['critical', 'score-drop', 'soroban-audit'],
    CERT_SIGNATURE_FAILURE: ['error', 'certificate', 'tamper', 'soroban-audit'],
  };

  const details = buildDetails(ctx);

  const payload = {
    message: buildSummary(ctx),
    alias: dedupKey, // dedup key — Opsgenie deduplicates by alias
    description: ctx.detail ?? buildSummary(ctx),
    priority,
    tags: tagMap[ctx.trigger],
    details: Object.fromEntries(Object.entries(details).map(([k, v]) => [k, String(v ?? '')])),
    source: 'soroban-explorer-audit-platform',
    entity: ctx.contractAddress,
  };

  try {
    const resp = await axios.post(OG_ALERT_URL(OG_REGION()), payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `GenieKey ${apiKey}`,
      },
      timeout: 10_000,
    });

    const requestId = (resp.data as { requestId?: string })?.requestId ?? dedupKey;
    logger.info('Opsgenie alert fired', { trigger: ctx.trigger, requestId });
    return { sent: true, skipped: false, dedupId: requestId, error: null };
  } catch (err) {
    const msg = String(err);
    logger.error('Opsgenie dispatch failed', { trigger: ctx.trigger, error: msg });
    return { sent: false, skipped: false, dedupId: null, error: msg.slice(0, 500) };
  }
}

// ── Dedup guard — persist in AuditEvent ──────────────────────────────────────

/**
 * Returns true if an incident for this dedupKey was already fired within
 * the past 6 hours (avoids re-paging on repeated score polls).
 */
async function isAlreadyOpen(contractAddress: string, dedupKey: string): Promise<boolean> {
  const since = new Date(Date.now() - 6 * 3600000);
  const existing = await prismaRead.auditEvent.findFirst({
    where: {
      contractAddress,
      eventType: 'vulnerability_discovered',
      details: {
        path: ['dedupKey'],
        equals: dedupKey,
      },
      timestamp: { gte: since },
    },
    select: { id: true },
  });
  return !!existing;
}

async function persistIncidentEvent(
  ctx: IncidentContext,
  dedupKey: string,
  pdResult: ChannelResult,
  ogResult: ChannelResult,
): Promise<void> {
  await prismaWrite.auditEvent
    .create({
      data: {
        contractAddress: ctx.contractAddress,
        certificateId: ctx.certId ?? null,
        eventType: 'vulnerability_discovered',
        triggerSource: 'automatic',
        timestamp: new Date(),
        details: {
          action: 'incident_dispatched',
          trigger: ctx.trigger,
          dedupKey,
          overallScore: ctx.overallScore ?? null,
          tvlUsd: ctx.tvlUsd ?? null,
          findingId: ctx.findingId ?? null,
          findingTitle: ctx.findingTitle ?? null,
          pagerduty: { sent: pdResult.sent, dedupId: pdResult.dedupId, error: pdResult.error },
          opsgenie: { sent: ogResult.sent, dedupId: ogResult.dedupId, error: ogResult.error },
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    })
    .catch((e) => logger.warn('Failed to persist incident event', { error: String(e) }));
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

/**
 * Fire PagerDuty + Opsgenie for a given audit incident context.
 * Handles deduplication, TVL gating, and persistent event logging.
 * Never throws — all errors are captured and returned.
 */
export async function dispatchIncident(ctx: IncidentContext): Promise<DispatchResult> {
  const dedupKey = buildDedupKey(ctx);

  // Deduplicate: skip if already paged in the last 6 hours
  const alreadyOpen = await isAlreadyOpen(ctx.contractAddress, dedupKey);
  if (alreadyOpen) {
    logger.info('Incident already open — skipping dispatch', {
      trigger: ctx.trigger,
      contractAddress: ctx.contractAddress,
    });
    return {
      trigger: ctx.trigger,
      contractAddress: ctx.contractAddress,
      pagerduty: { sent: false, skipped: true, dedupId: null, error: 'duplicate' },
      opsgenie: { sent: false, skipped: true, dedupId: null, error: 'duplicate' },
      dedupKey,
      alreadyOpen: true,
    };
  }

  // Fire both platforms in parallel
  const [pdResult, ogResult] = await Promise.all([
    firePagerDuty(ctx, dedupKey),
    fireOpsgenie(ctx, dedupKey),
  ]);

  await persistIncidentEvent(ctx, dedupKey, pdResult, ogResult);

  return {
    trigger: ctx.trigger,
    contractAddress: ctx.contractAddress,
    pagerduty: pdResult,
    opsgenie: ogResult,
    dedupKey,
    alreadyOpen: false,
  };
}

// ── Trigger-specific convenience wrappers ────────────────────────────────────

/**
 * Trigger 1: Critical finding in contract with TVL > $1 M.
 * Called from audit-monitor.ts emitPostAuditAlerts() for each critical finding.
 */
export async function incidentCriticalFinding(
  contractAddress: string,
  certId: string,
  findingId: string,
  findingTitle: string,
): Promise<void> {
  const tvlUsd = await getContractTvlUsd(contractAddress);
  if (tvlUsd < TVL_THRESHOLD) return; // only page for high-TVL contracts

  await dispatchIncident({
    trigger: 'CRITICAL_FINDING_HIGH_TVL',
    contractAddress,
    certId,
    findingId,
    findingTitle,
    findingSeverity: 'critical',
    tvlUsd,
    detail: `Critical finding "${findingTitle}" discovered in contract with $${tvlUsd.toLocaleString()} TVL.`,
  }).catch((e) => logger.warn('incidentCriticalFinding dispatch error', { error: String(e) }));
}

/**
 * Trigger 2: Audit score drops below CRITICAL_SCORE_THRESHOLD (30).
 * Called from audit-monitor.ts emitPostAuditAlerts() after cert publish.
 */
export async function incidentScoreDropBelowThreshold(
  contractAddress: string,
  certId: string,
  overallScore: number,
): Promise<void> {
  if (overallScore >= SCORE_THRESHOLD) return;

  const tvlUsd = await getContractTvlUsd(contractAddress);

  await dispatchIncident({
    trigger: 'SCORE_BELOW_THRESHOLD',
    contractAddress,
    certId,
    overallScore,
    tvlUsd,
    detail: `Audit score is ${overallScore}/100 — below critical threshold of ${SCORE_THRESHOLD}. TVL: $${tvlUsd.toLocaleString()}`,
  }).catch((e) =>
    logger.warn('incidentScoreDropBelowThreshold dispatch error', { error: String(e) }),
  );
}

/**
 * Trigger 3: Certificate signature verification failure.
 * Called from audit-verify.ts when a valid cert's signature fails.
 */
export async function incidentSignatureFailure(
  contractAddress: string,
  certId: string,
  certHash: string,
): Promise<void> {
  await dispatchIncident({
    trigger: 'CERT_SIGNATURE_FAILURE',
    contractAddress,
    certId,
    certHash,
    detail: `Certificate hash ${certHash.slice(0, 16)}... failed HMAC-SHA256 signature verification. Possible tampering.`,
  }).catch((e) => logger.warn('incidentSignatureFailure dispatch error', { error: String(e) }));
}
