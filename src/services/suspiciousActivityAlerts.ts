/**
 * Suspicious Activity Alert Service
 *
 * A single, centralised rule engine that watches indexed events/transactions and
 * emits notifications for suspicious on-chain patterns:
 *
 *   - rapid_value_movement — bursts of large value out of one account in a short window
 *   - unusual_approval     — unlimited / large / first-time token approvals
 *   - wash_trading         — self-trades, round-trips and rapid back-and-forth pairs
 *   - velocity_anomaly     — statistically abnormal per-minute activity for a subject
 *
 * Consumers (`src/api/fraud.ts`, emergency, compliance, …) subscribe to one feed
 * via `getSuspiciousActivityAlertService().onAlert(handler)` or by reading the
 * in-app inbox through the `/alert-rules` API.
 *
 * Alerts are fanned out to three pluggable sinks:
 *   - inApp  : bounded in-memory inbox + `alert` event (default channels)
 *   - webhook: HMAC-signed POST via the SSRF-guarded transport
 *   - sse    : `streamingServer.broadcast('alerts', …)` for live subscribers
 *
 * Rules are enabled per tenant (API-key / developer id) with sensible defaults;
 * overrides may be supplied at runtime and are held in an in-memory registry.
 *
 * Dedupe collapses identical (rule, subject, bucket) detections and a per-rule
 * cooldown + global rate cap throttles noisy rules.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../logger';
import { safePost } from '../webhooks/ssrf-guard';

// ── Public types ──────────────────────────────────────────────────────────────

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AlertRuleId =
  'rapid_value_movement' | 'unusual_approval' | 'wash_trading' | 'velocity_anomaly';

export const ALERT_SEVERITIES: AlertSeverity[] = ['low', 'medium', 'high', 'critical'];

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Normalised shape for any indexed transaction or contract event. */
export interface IndexedActivity {
  id: string;
  kind: 'transaction' | 'event';
  transactionHash?: string;
  contractAddress?: string;
  sourceAccount?: string;
  destinationAccount?: string;
  eventType?: string;
  topicSymbol?: string;
  asset?: string;
  /** Normalised numeric value (USDC/stroops-normalised by the caller). */
  amount?: number;
  /** Approval spender / operator, when the activity is an approval. */
  spender?: string;
  ledgerSequence?: number;
  timestamp: Date;
  decoded?: Record<string, unknown>;
}

export interface RuleSignal {
  ruleId: AlertRuleId;
  severity: AlertSeverity;
  /** Primary entity the alert is about (address, contract, or pair). */
  subject: string;
  score: number;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  /** Extra specificity folded into the dedupe fingerprint. */
  dedupeKey?: string;
}

export interface RuleContext {
  /** Sliding window of recent activity, most recent last (includes current). */
  window: IndexedActivity[];
  now: number;
  windowMs: number;
}

export interface AlertRule {
  id: AlertRuleId;
  name: string;
  description: string;
  defaultEnabled: boolean;
  defaultCooldownMs: number;
  defaultSeverity: AlertSeverity;
  evaluate(activity: IndexedActivity, ctx: RuleContext): RuleSignal[];
}

export interface SuspiciousAlert {
  id: string;
  tenantId: string;
  ruleId: AlertRuleId;
  ruleName: string;
  severity: AlertSeverity;
  score: number;
  subject: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  activity: IndexedActivity;
  detectedAt: string;
}

export interface TenantRuleOverride {
  enabled?: boolean;
  cooldownMs?: number;
  /** Minimum severity that survives for this rule. */
  minSeverity?: AlertSeverity;
}

export interface TenantAlertConfigInput {
  rules?: Partial<Record<AlertRuleId, TenantRuleOverride>>;
  webhookUrls?: string[];
  webhookSecret?: string;
}

export interface ResolvedRuleConfig {
  enabled: boolean;
  cooldownMs: number;
  minSeverity: AlertSeverity;
}

export interface ResolvedTenantConfig {
  tenantId: string;
  rules: Record<AlertRuleId, ResolvedRuleConfig>;
  webhookUrls: string[];
  webhookSecret?: string;
}

export interface AlertSinkContext {
  config: ResolvedTenantConfig;
}

export interface AlertSink {
  readonly name: string;
  deliver(alert: SuspiciousAlert, ctx: AlertSinkContext): Promise<void> | void;
}

// ── Tunables (exported so tests and callers can reason about thresholds) ──────

export const ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
export const MAX_WINDOW_SIZE = 5_000;
export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
export const DEFAULT_RULE_RATE_LIMIT_PER_MINUTE = 120;

export const VALUE_MOVEMENT_WINDOW_MS = 5 * 60 * 1000;
export const VALUE_MOVEMENT_MIN_COUNT = 3;
export const VALUE_MOVEMENT_TOTAL_THRESHOLD = 100_000;
export const SINGLE_VALUE_MOVEMENT_THRESHOLD = 250_000;

export const LARGE_APPROVAL_THRESHOLD = 50_000;
export const UNLIMITED_APPROVAL_VALUE = 2 ** 64;

export const WASH_TRADE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WASH_TRADE_MIN_PAIR_TRADES = 3;

export const VELOCITY_BUCKET_MS = 60_000;
export const VELOCITY_ZSCORE_THRESHOLD = 3;

// ── Shared helpers ────────────────────────────────────────────────────────────

function severityAtLeast(severity: AlertSeverity, min: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

function normalizeTimestamp(value: Date | string | number | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function toMillis(value: Date | string | number): number {
  return normalizeTimestamp(value).getTime();
}

/** Lenient input shape accepted by `normalizeActivity` / `ingest`. */
export type ActivityInput = Omit<Partial<IndexedActivity>, 'timestamp'> & {
  timestamp?: Date | string | number;
};

/**
 * Normalise a partial activity record. Callers can pass whatever shape their
 * ingestion path already has; missing fields are left undefined rather than
 * guessed.
 */
export function normalizeActivity(input: ActivityInput): IndexedActivity {
  const decoded = (input.decoded ?? {}) as Record<string, unknown>;
  return {
    id: input.id ?? `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind ?? 'event',
    transactionHash: input.transactionHash,
    contractAddress: input.contractAddress,
    sourceAccount: input.sourceAccount ?? firstString(decoded.from, decoded.owner, decoded.sender),
    destinationAccount:
      input.destinationAccount ?? firstString(decoded.to, decoded.recipient, decoded.receiver),
    eventType: input.eventType ?? input.topicSymbol,
    topicSymbol: input.topicSymbol,
    asset: input.asset ?? firstString(decoded.asset, decoded.assetCode, decoded.currency),
    amount:
      input.amount ??
      firstNumber(decoded.amount, decoded.value, decoded.amountIn, decoded.amountOut, decoded.qty),
    spender:
      input.spender ??
      firstString(decoded.spender, decoded.approved, decoded.operator, decoded.delegate),
    ledgerSequence: input.ledgerSequence,
    timestamp: normalizeTimestamp(input.timestamp),
    decoded,
  };
}

/** Map a persisted `Event` row to a normalised activity. */
export function fromIndexedEvent(row: {
  id: string;
  transactionHash?: string;
  contractAddress?: string;
  eventType?: string;
  topicSymbol?: string | null;
  decoded?: unknown;
  ledgerSequence?: number;
  ledgerCloseTime?: Date | string;
}): IndexedActivity {
  const decoded = (row.decoded ?? {}) as Record<string, unknown>;
  return normalizeActivity({
    id: row.id,
    kind: 'event',
    transactionHash: row.transactionHash,
    contractAddress: row.contractAddress,
    eventType: row.eventType,
    topicSymbol: row.topicSymbol ?? undefined,
    ledgerSequence: row.ledgerSequence,
    timestamp: row.ledgerCloseTime,
    decoded,
  });
}

/** Map a persisted `Transaction` row to a normalised activity. */
export function fromIndexedTransaction(row: {
  id: string;
  hash?: string;
  contractAddress?: string | null;
  sourceAccount?: string;
  functionName?: string | null;
  functionArgs?: unknown;
  ledgerSequence?: number;
  ledgerCloseTime?: Date | string;
}): IndexedActivity {
  const args = (row.functionArgs ?? {}) as Record<string, unknown>;
  return normalizeActivity({
    id: row.id,
    kind: 'transaction',
    transactionHash: row.hash,
    contractAddress: row.contractAddress ?? undefined,
    sourceAccount: row.sourceAccount,
    eventType: row.functionName ?? undefined,
    ledgerSequence: row.ledgerSequence,
    timestamp: row.ledgerCloseTime,
    decoded: args,
  });
}

// ── Built-in rule definitions ─────────────────────────────────────────────────

const APPROVAL_PATTERN = /approv|allowance|authoriz|enable_/i;
const TRADE_PATTERN = /swap|trade|trad|sale|match|fill/i;
const UNLIMITED_HINT = /unlimited|infinite|max|u64::max|i64::max/i;

function subjectOf(activity: IndexedActivity): string {
  return (
    activity.sourceAccount ??
    activity.contractAddress ??
    activity.spender ??
    activity.destinationAccount ??
    'unknown'
  );
}

function inWindow(activity: IndexedActivity, ctx: RuleContext, cutoffMs: number): boolean {
  return toMillis(activity.timestamp) >= ctx.now - cutoffMs;
}

const rapidValueMovementRule: AlertRule = {
  id: 'rapid_value_movement',
  name: 'Rapid value movement',
  description:
    'Multiple large transfers or a single very large transfer from one account inside a short window.',
  defaultEnabled: true,
  defaultCooldownMs: 60_000,
  defaultSeverity: 'high',
  evaluate(activity, ctx) {
    const amount = activity.amount;
    if (amount === undefined || amount <= 0) return [];

    const subject = subjectOf(activity);

    if (amount >= SINGLE_VALUE_MOVEMENT_THRESHOLD) {
      return [
        {
          ruleId: this.id,
          severity: 'high',
          subject,
          score: Math.min(1, amount / SINGLE_VALUE_MOVEMENT_THRESHOLD),
          title: 'Very large single value movement',
          description: `A single movement of ${amount} left ${subject}`,
          evidence: { amount, threshold: SINGLE_VALUE_MOVEMENT_THRESHOLD, kind: 'single' },
          dedupeKey: 'single',
        },
      ];
    }

    const related = ctx.window.filter(
      (a) =>
        a.id !== activity.id &&
        subjectOf(a) === subject &&
        a.amount !== undefined &&
        a.amount > 0 &&
        inWindow(a, ctx, VALUE_MOVEMENT_WINDOW_MS),
    );

    if (related.length + 1 < VALUE_MOVEMENT_MIN_COUNT) return [];

    const total = related.reduce((sum, a) => sum + (a.amount ?? 0), amount);
    if (total < VALUE_MOVEMENT_TOTAL_THRESHOLD) return [];

    return [
      {
        ruleId: this.id,
        severity: total >= VALUE_MOVEMENT_TOTAL_THRESHOLD * 2 ? 'critical' : 'high',
        subject,
        score: Math.min(1, total / (VALUE_MOVEMENT_TOTAL_THRESHOLD * 2)),
        title: 'Rapid value movement',
        description: `${related.length + 1} movements totalling ${total} from ${subject} within ${VALUE_MOVEMENT_WINDOW_MS / 1000}s`,
        evidence: {
          kind: 'burst',
          count: related.length + 1,
          total,
          threshold: VALUE_MOVEMENT_TOTAL_THRESHOLD,
          windowMs: VALUE_MOVEMENT_WINDOW_MS,
        },
        dedupeKey: `burst:${Math.floor(ctx.now / VALUE_MOVEMENT_WINDOW_MS)}`,
      },
    ];
  },
};

const unusualApprovalRule: AlertRule = {
  id: 'unusual_approval',
  name: 'Unusual approval',
  description:
    'Unlimited allowances, large approvals, self-approvals, or approvals to a first-time spender.',
  defaultEnabled: true,
  defaultCooldownMs: 300_000,
  defaultSeverity: 'medium',
  evaluate(activity, ctx) {
    const label = `${activity.eventType ?? ''} ${activity.topicSymbol ?? ''}`;
    const decodedText = activity.decoded ? JSON.stringify(activity.decoded) : '';
    if (!APPROVAL_PATTERN.test(label) && !APPROVAL_PATTERN.test(decodedText)) return [];

    const subject = subjectOf(activity);
    const spender = activity.spender;
    const amount = activity.amount;
    const signals: RuleSignal[] = [];

    const looksUnlimited =
      amount === undefined
        ? UNLIMITED_HINT.test(decodedText)
        : amount >= UNLIMITED_APPROVAL_VALUE || UNLIMITED_HINT.test(decodedText);

    if (spender && spender === subject) {
      signals.push({
        ruleId: this.id,
        severity: 'high',
        subject,
        score: 0.7,
        title: 'Self-approval detected',
        description: `${subject} approved itself as spender`,
        evidence: { spender, amount },
        dedupeKey: `self:${spender}`,
      });
      return signals;
    }

    if (looksUnlimited) {
      signals.push({
        ruleId: this.id,
        severity: 'high',
        subject,
        score: 0.9,
        title: 'Unlimited token approval',
        description: `${subject} granted an unlimited allowance${spender ? ` to ${spender}` : ''}`,
        evidence: { spender, unlimited: true },
        dedupeKey: `unlimited:${spender ?? 'unknown'}`,
      });
      return signals;
    }

    if (amount !== undefined && amount >= LARGE_APPROVAL_THRESHOLD) {
      const priorWithSpender = ctx.window.some(
        (a) =>
          a.id !== activity.id && a.spender === spender && inWindow(a, ctx, WASH_TRADE_WINDOW_MS),
      );
      signals.push({
        ruleId: this.id,
        severity: priorWithSpender ? 'medium' : 'high',
        subject,
        score: priorWithSpender ? 0.5 : 0.65,
        title: priorWithSpender ? 'Large token approval' : 'Large approval to new spender',
        description: `${subject} approved ${amount}${spender ? ` to ${spender}` : ''}${priorWithSpender ? '' : ' (first-time spender)'}`,
        evidence: { spender, amount, firstTimeSpender: !priorWithSpender },
        dedupeKey: `large:${spender ?? 'unknown'}`,
      });
    }

    return signals;
  },
};

interface TradeParties {
  buyer: string;
  seller: string;
}

function extractTradeParties(activity: IndexedActivity): TradeParties | null {
  const decoded = (activity.decoded ?? {}) as Record<string, unknown>;
  const seller = firstString(
    activity.sourceAccount,
    decoded.seller,
    decoded.maker,
    decoded.from,
    decoded.sender,
  );
  const buyer = firstString(
    activity.destinationAccount,
    decoded.buyer,
    decoded.taker,
    decoded.to,
    decoded.recipient,
  );
  if (!seller || !buyer) return null;
  return { buyer, seller };
}

function tradeKey(parties: TradeParties): string {
  return [parties.buyer, parties.seller].sort().join('::');
}

const washTradingRule: AlertRule = {
  id: 'wash_trading',
  name: 'Wash trading',
  description: 'Self-trades, same-item round-trips and rapid back-and-forth between two wallets.',
  defaultEnabled: true,
  defaultCooldownMs: 600_000,
  defaultSeverity: 'high',
  evaluate(activity, ctx) {
    const label = `${activity.eventType ?? ''} ${activity.topicSymbol ?? ''}`;
    const decodedText = activity.decoded ? JSON.stringify(activity.decoded) : '';
    if (!TRADE_PATTERN.test(label) && !TRADE_PATTERN.test(decodedText)) return [];

    const parties = extractTradeParties(activity);
    if (!parties) return [];

    const key = tradeKey(parties);

    if (parties.buyer === parties.seller) {
      return [
        {
          ruleId: this.id,
          severity: 'critical',
          subject: parties.buyer,
          score: 1,
          title: 'Self-trade detected',
          description: `${parties.buyer} traded with itself`,
          evidence: { ...parties },
          dedupeKey: 'self',
        },
      ];
    }

    const recent = ctx.window.filter(
      (a) =>
        a.id !== activity.id &&
        inWindow(a, ctx, WASH_TRADE_WINDOW_MS) &&
        TRADE_PATTERN.test(`${a.eventType ?? ''} ${a.topicSymbol ?? ''}`),
    );

    const roundTrip = recent.find((a) => {
      const p = extractTradeParties(a);
      return p && p.buyer === parties.seller && p.seller === parties.buyer;
    });

    if (roundTrip) {
      return [
        {
          ruleId: this.id,
          severity: 'high',
          subject: key,
          score: 0.85,
          title: 'Wash trade round-trip',
          description: `${parties.buyer} and ${parties.seller} traded the same direction back and forth`,
          evidence: { ...parties, roundTripId: roundTrip.id },
          dedupeKey: 'roundtrip',
        },
      ];
    }

    const pairTrades = recent.filter((a) => {
      const p = extractTradeParties(a);
      return p && tradeKey(p) === key;
    });

    if (pairTrades.length + 1 >= WASH_TRADE_MIN_PAIR_TRADES) {
      return [
        {
          ruleId: this.id,
          severity: 'medium',
          subject: key,
          score: Math.min(0.9, 0.4 + pairTrades.length * 0.1),
          title: 'Rapid back-and-forth trading',
          description: `${pairTrades.length + 1} trades between ${parties.buyer} and ${parties.seller} in ${WASH_TRADE_WINDOW_MS / 3600000}h`,
          evidence: { ...parties, tradeCount: pairTrades.length + 1 },
          dedupeKey: `pair:${Math.floor(ctx.now / WASH_TRADE_WINDOW_MS)}`,
        },
      ];
    }

    return [];
  },
};

const velocityAnomalyRule: AlertRule = {
  id: 'velocity_anomaly',
  name: 'Velocity anomaly',
  description: 'Statistically abnormal per-minute activity for a single subject (z-score based).',
  defaultEnabled: true,
  defaultCooldownMs: 120_000,
  defaultSeverity: 'medium',
  evaluate(activity, ctx) {
    const subject = subjectOf(activity);
    const activities = ctx.window.filter(
      (a) => subjectOf(a) === subject && inWindow(a, ctx, ctx.windowMs),
    );

    const buckets = new Map<number, number>();
    for (const a of activities) {
      const bucket = Math.floor(toMillis(a.timestamp) / VELOCITY_BUCKET_MS);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }

    // Need a baseline before declaring anything anomalous.
    if (buckets.size < 4) return [];

    const counts = Array.from(buckets.values());
    const currentBucket = Math.floor(ctx.now / VELOCITY_BUCKET_MS);
    const currentCount = buckets.get(currentBucket) ?? 0;

    const baselineCounts = counts.filter((_, i) => Array.from(buckets.keys())[i] !== currentBucket);
    if (baselineCounts.length < 3) return [];

    const mean = baselineCounts.reduce((s, c) => s + c, 0) / baselineCounts.length;
    const variance =
      baselineCounts.reduce((s, c) => s + (c - mean) ** 2, 0) / baselineCounts.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return [];

    const zScore = (currentCount - mean) / stdDev;
    if (zScore < VELOCITY_ZSCORE_THRESHOLD) return [];

    return [
      {
        ruleId: this.id,
        severity: zScore >= VELOCITY_ZSCORE_THRESHOLD * 2 ? 'high' : 'medium',
        subject,
        score: Math.min(1, zScore / (VELOCITY_ZSCORE_THRESHOLD * 3)),
        title: 'Abnormal activity velocity',
        description: `${subject} produced ${currentCount} activities this minute (baseline mean ${mean.toFixed(2)}, z=${zScore.toFixed(2)})`,
        evidence: {
          currentCount,
          mean,
          stdDev,
          zScore,
          windowMs: ctx.windowMs,
        },
        dedupeKey: `bucket:${currentBucket}`,
      },
    ];
  },
};

export const BUILT_IN_ALERT_RULES: AlertRule[] = [
  rapidValueMovementRule,
  unusualApprovalRule,
  washTradingRule,
  velocityAnomalyRule,
];

// ── Sinks ─────────────────────────────────────────────────────────────────────

/**
 * In-app sink — the default notification channel. Alerts land in a bounded
 * per-tenant inbox and are also exposed through the engine's `alert` event.
 */
export class InAppAlertSink implements AlertSink {
  readonly name = 'inApp';
  private inbox: SuspiciousAlert[] = [];
  private maxInbox: number;

  constructor(maxInbox = 1_000) {
    this.maxInbox = maxInbox;
  }

  deliver(alert: SuspiciousAlert): void {
    this.inbox.push(alert);
    if (this.inbox.length > this.maxInbox) {
      this.inbox.splice(0, this.inbox.length - this.maxInbox);
    }
  }

  getInbox(tenantId?: string, limit = 50): SuspiciousAlert[] {
    const filtered = tenantId ? this.inbox.filter((a) => a.tenantId === tenantId) : this.inbox;
    return filtered.slice(-limit);
  }

  reset(): void {
    this.inbox = [];
  }
}

/**
 * Webhook sink — HMAC-signs the alert and POSTs it through the SSRF-guarded
 * transport. Failures are logged and swallowed so one bad endpoint cannot
 * block the alert feed.
 */
export class WebhookAlertSink implements AlertSink {
  readonly name = 'webhook';
  private timeoutMs: number;

  constructor(timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  async deliver(alert: SuspiciousAlert, ctx: AlertSinkContext): Promise<void> {
    const urls = new Set<string>(ctx.config.webhookUrls);
    for (const envUrl of [
      process.env.SUSPICIOUS_ALERT_WEBHOOK_URL,
      process.env.ALERT_WEBHOOK_URL,
    ]) {
      if (envUrl) urls.add(envUrl);
    }
    if (urls.size === 0) return;

    const body = JSON.stringify({ alert });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Alert-Rule': alert.ruleId,
      'X-Alert-Severity': alert.severity,
    };
    const secret = ctx.config.webhookSecret ?? process.env.SUSPICIOUS_ALERT_WEBHOOK_SECRET;
    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      headers['X-Alert-Signature'] = `sha256=${sig}`;
    }

    await Promise.all(
      Array.from(urls).map(async (url) => {
        try {
          const response = await safePost(url, body, headers, this.timeoutMs);
          if (response.status < 200 || response.status >= 300) {
            logger.warn('[suspicious-alerts] webhook returned non-2xx', {
              url,
              status: response.status,
              alertId: alert.id,
            });
          }
        } catch (err) {
          logger.warn('[suspicious-alerts] webhook delivery failed', {
            url,
            alertId: alert.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }
}

/**
 * SSE sink — broadcasts the alert on the `alerts` feed channel so browsers and
 * other consumers connected to `/feed/sse?channels=alerts` receive it live.
 * The streaming server is imported lazily to keep the feed stack out of the
 * module graph for callers that never use SSE.
 */
export class SseAlertSink implements AlertSink {
  readonly name = 'sse';

  async deliver(alert: SuspiciousAlert): Promise<void> {
    try {
      const { streamingServer } = await import('../feed/streamingServer');
      streamingServer.broadcast('alerts', {
        data: alert,
        timestamp: alert.detectedAt,
      });
    } catch (err) {
      logger.warn('[suspicious-alerts] SSE broadcast failed', {
        alertId: alert.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function createDefaultAlertSinks(): AlertSink[] {
  return [new InAppAlertSink(), new WebhookAlertSink(), new SseAlertSink()];
}

// ── Engine ────────────────────────────────────────────────────────────────────

export interface SuspiciousActivityAlertOptions {
  windowMs?: number;
  maxWindowSize?: number;
  dedupeWindowMs?: number;
  ruleRateLimitPerMinute?: number;
  sinks?: AlertSink[];
  now?: () => number;
}

const SEVERITY_ORDER = SEVERITY_RANK;

export class SuspiciousActivityAlertService extends EventEmitter {
  private rules = new Map<AlertRuleId, AlertRule>();
  private tenantConfigs = new Map<string, TenantAlertConfigInput>();
  private window: IndexedActivity[] = [];
  private dedupe = new Map<string, number>();
  private throttle = new Map<string, number>();
  private ruleEmissions = new Map<AlertRuleId, number[]>();
  private recent: SuspiciousAlert[] = [];
  private maxRecent = 1_000;

  private readonly windowMs: number;
  private readonly maxWindowSize: number;
  private readonly dedupeWindowMs: number;
  private readonly ruleRateLimitPerMinute: number;
  private readonly now: () => number;

  private inAppSink: InAppAlertSink;
  private sinks: AlertSink[];

  constructor(options: SuspiciousActivityAlertOptions = {}) {
    super();
    this.windowMs = options.windowMs ?? ACTIVITY_WINDOW_MS;
    this.maxWindowSize = options.maxWindowSize ?? MAX_WINDOW_SIZE;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.ruleRateLimitPerMinute =
      options.ruleRateLimitPerMinute ?? DEFAULT_RULE_RATE_LIMIT_PER_MINUTE;
    this.now = options.now ?? (() => Date.now());

    this.sinks = options.sinks ? [...options.sinks] : createDefaultAlertSinks();

    const inApp = this.sinks.find((s): s is InAppAlertSink => s instanceof InAppAlertSink);
    if (inApp) {
      this.inAppSink = inApp;
    } else {
      this.inAppSink = new InAppAlertSink();
      this.sinks.push(this.inAppSink);
    }

    for (const rule of BUILT_IN_ALERT_RULES) {
      this.registerRule(rule);
    }
  }

  // ── Rule registry ───────────────────────────────────────────────────────────

  registerRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  unregisterRule(id: AlertRuleId): void {
    this.rules.delete(id);
  }

  listRules(): Array<{
    id: AlertRuleId;
    name: string;
    description: string;
    defaultEnabled: boolean;
    defaultCooldownMs: number;
    defaultSeverity: AlertSeverity;
  }> {
    return Array.from(this.rules.values()).map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      defaultEnabled: rule.defaultEnabled,
      defaultCooldownMs: rule.defaultCooldownMs,
      defaultSeverity: rule.defaultSeverity,
    }));
  }

  // ── Per-tenant configuration ────────────────────────────────────────────────

  getTenantConfig(tenantId: string): ResolvedTenantConfig {
    const override = this.tenantConfigs.get(tenantId);
    const rules = {} as Record<AlertRuleId, ResolvedRuleConfig>;

    for (const rule of this.rules.values()) {
      const ruleOverride = override?.rules?.[rule.id];
      rules[rule.id] = {
        enabled: ruleOverride?.enabled ?? rule.defaultEnabled,
        cooldownMs: ruleOverride?.cooldownMs ?? rule.defaultCooldownMs,
        minSeverity: ruleOverride?.minSeverity ?? 'low',
      };
    }

    return {
      tenantId,
      rules,
      webhookUrls: override?.webhookUrls ?? [],
      webhookSecret: override?.webhookSecret,
    };
  }

  setTenantConfig(tenantId: string, update: TenantAlertConfigInput): ResolvedTenantConfig {
    const current = this.tenantConfigs.get(tenantId) ?? {};
    const merged: TenantAlertConfigInput = {
      ...current,
      ...update,
      rules: { ...(current.rules ?? {}), ...(update.rules ?? {}) },
    };
    this.tenantConfigs.set(tenantId, merged);
    return this.getTenantConfig(tenantId);
  }

  resetTenantConfig(tenantId: string): ResolvedTenantConfig {
    this.tenantConfigs.delete(tenantId);
    return this.getTenantConfig(tenantId);
  }

  listTenants(): string[] {
    return Array.from(this.tenantConfigs.keys());
  }

  // ── Sinks & subscriptions ───────────────────────────────────────────────────

  registerSink(sink: AlertSink): void {
    this.sinks.push(sink);
  }

  listSinks(): string[] {
    return this.sinks.map((s) => s.name);
  }

  /** Subscribe to the central alert feed. Returns an unsubscribe function. */
  onAlert(listener: (alert: SuspiciousAlert) => void): () => void {
    this.on('alert', listener);
    return () => this.off('alert', listener);
  }

  getRecentAlerts(limit = 50, tenantId?: string): SuspiciousAlert[] {
    const filtered = tenantId ? this.recent.filter((a) => a.tenantId === tenantId) : this.recent;
    return filtered.slice(-limit);
  }

  getInbox(tenantId?: string, limit = 50): SuspiciousAlert[] {
    return this.inAppSink.getInbox(tenantId, limit);
  }

  stats(): {
    windowSize: number;
    recentAlerts: number;
    tenants: number;
    rules: number;
    sinks: string[];
  } {
    return {
      windowSize: this.window.length,
      recentAlerts: this.recent.length,
      tenants: this.tenantConfigs.size,
      rules: this.rules.size,
      sinks: this.listSinks(),
    };
  }

  // ── Ingestion ───────────────────────────────────────────────────────────────

  async ingest(
    input: ActivityInput | ActivityInput[],
    tenantId = 'default',
  ): Promise<SuspiciousAlert[]> {
    const activities = (Array.isArray(input) ? input : [input]).map((a) => normalizeActivity(a));
    const emitted: SuspiciousAlert[] = [];
    for (const activity of activities) {
      emitted.push(...(await this.evaluateActivity(activity, tenantId)));
    }
    return emitted;
  }

  private async evaluateActivity(
    activity: IndexedActivity,
    tenantId: string,
  ): Promise<SuspiciousAlert[]> {
    const now = this.now();
    this.pushWindow(activity);

    const config = this.getTenantConfig(tenantId);
    const ctx: RuleContext = { window: this.window, now, windowMs: this.windowMs };
    const alerts: SuspiciousAlert[] = [];

    for (const rule of this.rules.values()) {
      const ruleConfig = config.rules[rule.id];
      if (!ruleConfig?.enabled) continue;

      let signals: RuleSignal[] = [];
      try {
        signals = rule.evaluate(activity, ctx) ?? [];
      } catch (err) {
        logger.error(`[suspicious-alerts] rule ${rule.id} threw`, {
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const signal of signals) {
        if (!severityAtLeast(signal.severity, ruleConfig.minSeverity)) continue;
        if (!this.passesDedupe(tenantId, signal, now)) continue;
        if (!this.passesThrottle(tenantId, signal, ruleConfig.cooldownMs, now)) continue;

        const alert: SuspiciousAlert = {
          id: `alert_${now}_${Math.random().toString(36).slice(2, 10)}`,
          tenantId,
          ruleId: signal.ruleId,
          ruleName: rule.name,
          severity: signal.severity,
          score: signal.score,
          subject: signal.subject,
          title: signal.title,
          description: signal.description,
          evidence: signal.evidence,
          activity,
          detectedAt: new Date(now).toISOString(),
        };

        this.recordEmission(alert, signal, now);
        alerts.push(alert);
        await this.dispatch(alert, config);
      }
    }

    return alerts;
  }

  private pushWindow(activity: IndexedActivity): void {
    this.window.push(activity);
    if (this.window.length > this.maxWindowSize) {
      this.window.splice(0, this.window.length - this.maxWindowSize);
    }
  }

  private fingerprint(tenantId: string, signal: RuleSignal): string {
    return `${tenantId}:${signal.ruleId}:${signal.subject}:${signal.dedupeKey ?? ''}`;
  }

  private passesDedupe(tenantId: string, signal: RuleSignal, now: number): boolean {
    const key = this.fingerprint(tenantId, signal);
    const last = this.dedupe.get(key);
    if (last !== undefined && now - last < this.dedupeWindowMs) return false;
    this.dedupe.set(key, now);
    return true;
  }

  private passesThrottle(
    tenantId: string,
    signal: RuleSignal,
    cooldownMs: number,
    now: number,
  ): boolean {
    const key = `${tenantId}:${signal.ruleId}`;
    const last = this.throttle.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;

    const emissions = (this.ruleEmissions.get(signal.ruleId) ?? []).filter((t) => now - t < 60_000);
    if (emissions.length >= this.ruleRateLimitPerMinute) return false;

    this.throttle.set(key, now);
    return true;
  }

  private recordEmission(alert: SuspiciousAlert, signal: RuleSignal, now: number): void {
    const emissions = (this.ruleEmissions.get(signal.ruleId) ?? []).filter((t) => now - t < 60_000);
    emissions.push(now);
    this.ruleEmissions.set(signal.ruleId, emissions);

    this.recent.push(alert);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }
  }

  private async dispatch(alert: SuspiciousAlert, config: ResolvedTenantConfig): Promise<void> {
    this.emit('alert', alert);

    const results = await Promise.allSettled(
      this.sinks.map(async (sink) => sink.deliver(alert, { config })),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn('[suspicious-alerts] sink failed', {
          sink: this.sinks[index].name,
          alertId: alert.id,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  /**
   * Prune the sliding window and reset dedupe/throttle state. Intended for
   * tests and long-lived processes that want a hard reset.
   */
  reset(): void {
    this.window = [];
    this.dedupe.clear();
    this.throttle.clear();
    this.ruleEmissions.clear();
    this.recent = [];
    this.inAppSink.reset();
  }

  /** Drop entries older than the engine window (called opportunistically). */
  pruneWindow(): void {
    const cutoff = this.now() - this.windowMs;
    this.window = this.window.filter((a) => toMillis(a.timestamp) >= cutoff);
  }

  /** Ordered severity helper for callers building filters. */
  static severityRank(severity: AlertSeverity): number {
    return SEVERITY_ORDER[severity];
  }
}

// ── Singleton accessor ────────────────────────────────────────────────────────

let singleton: SuspiciousActivityAlertService | null = null;

export function getSuspiciousActivityAlertService(): SuspiciousActivityAlertService {
  if (!singleton) {
    singleton = new SuspiciousActivityAlertService();
  }
  return singleton;
}

/** Replace the singleton — testing hook only. */
export function _setSuspiciousActivityAlertService(
  service: SuspiciousActivityAlertService | null,
): void {
  singleton = service;
}
