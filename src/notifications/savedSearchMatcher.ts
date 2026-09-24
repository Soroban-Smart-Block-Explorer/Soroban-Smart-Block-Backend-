/**
 * Saved search matcher + notifier.
 *
 * Bridges persisted saved searches (see src/api/saved-searches.ts) to the
 * existing delivery machinery instead of adding a parallel notification stack:
 *
 *   - `NotificationService` (src/notifications/notificationService.ts) for
 *     FCM / APNs / WebPush fan-out.
 *   - `safePost` (src/webhooks/ssrf-guard.ts) for the per-search webhook and
 *     the operator-level ALERT_WEBHOOK_URL / SLACK_WEBHOOK_URL, matching the
 *     delivery style used by price alerts (src/api/alerts.ts).
 *
 * Matching itself is a pure function over indexed rows so it can be unit tested
 * and reused by both the API (`POST /saved-searches/:id/run`) and the indexer
 * runner (src/indexer/savedSearchRunner.ts).
 */

import { logger } from '../logger';
import { safePost } from '../webhooks/ssrf-guard';
import { NotificationService } from './notificationService';

export const SAVED_SEARCH_TARGETS = ['contract', 'event'] as const;
export type SavedSearchTarget = (typeof SAVED_SEARCH_TARGETS)[number];

/** Filters applied against a single indexed row. */
export interface SavedSearchCriteria {
  /** Contract address — applies to both contracts and events. */
  contractAddress?: string;
  /** Event type, e.g. "transfer". Events only. */
  eventType?: string;
  /** Topic symbol, e.g. "transfer". Events only. */
  topicSymbol?: string;
  /** Case-insensitive substring match on a contract's name. Contracts only. */
  nameContains?: string;
  /** Contracts only. */
  isToken?: boolean;
  /** Contracts only. */
  isVerified?: boolean;
  /** Minimum contract safety score (0-100). Contracts only. */
  minSafetyScore?: number;
  [key: string]: unknown;
}

/** Delivery configuration persisted alongside the search. */
export interface SavedSearchNotifyConfig {
  /** Per-search webhook destination (SSRF-guarded at delivery time). */
  webhookUrl?: string;
  /** Also fan out to SLACK_WEBHOOK_URL. */
  slack?: boolean;
  /** Also deliver via NotificationService to the caller-supplied devices. */
  push?: boolean;
  [key: string]: unknown;
}

/** The subset of a persisted SavedSearch row the matcher needs. */
export interface SavedSearchRecord {
  id: string;
  userId: string;
  name: string;
  targetType: SavedSearchTarget;
  criteria: SavedSearchCriteria;
  notify: SavedSearchNotifyConfig;
  isActive: boolean;
  /**
   * Cursor: only data indexed after this time is evaluated by the runner.
   * `null` means the search has never run (the runner applies its lookback).
   */
  lastRunAt?: Date | null;
}

/** A single indexed row normalised for matching. */
export interface MatchableEntity {
  targetType: SavedSearchTarget;
  contractAddress?: string;
  eventType?: string;
  topicSymbol?: string;
  name?: string;
  isToken?: boolean;
  isVerified?: boolean;
  safetyScore?: number | null;
  [key: string]: unknown;
}

export interface PushDevice {
  token: string;
  platform: string;
}

/** Shape of a persisted SavedSearch row as returned by Prisma. */
export interface SavedSearchRowLike {
  id: string;
  userId: string;
  name: string;
  targetType: string;
  criteria: unknown;
  notify: unknown;
  isActive: boolean;
  lastRunAt?: Date | null;
}

/** Normalise a persisted row into the matcher's typed record. */
export function toSavedSearchRecord(row: SavedSearchRowLike): SavedSearchRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    targetType: row.targetType as SavedSearchTarget,
    criteria: (row.criteria ?? {}) as SavedSearchCriteria,
    notify: (row.notify ?? {}) as SavedSearchNotifyConfig,
    isActive: row.isActive,
    lastRunAt: row.lastRunAt ?? null,
  };
}

export interface SavedSearchMatch {
  searchId: string;
  userId: string;
  searchName: string;
  targetType: SavedSearchTarget;
  entity: MatchableEntity;
  matchedAt: Date;
}

/**
 * Pure predicate: does `entity` satisfy `criteria` for `targetType`?
 *
 * Unset criteria are ignored (a search with no criteria matches everything of
 * its target type), so an empty criteria object acts as a "subscribe to all
 * new contracts/events" filter.
 */
export function matchesCriteria(
  targetType: SavedSearchTarget,
  criteria: SavedSearchCriteria,
  entity: MatchableEntity,
): boolean {
  if (entity.targetType !== targetType) return false;

  if (criteria.contractAddress !== undefined) {
    if (entity.contractAddress !== criteria.contractAddress) return false;
  }
  if (criteria.eventType !== undefined) {
    if (entity.eventType !== criteria.eventType) return false;
  }
  if (criteria.topicSymbol !== undefined) {
    if (entity.topicSymbol !== criteria.topicSymbol) return false;
  }
  if (criteria.nameContains !== undefined) {
    const needle = criteria.nameContains.toLowerCase();
    if (!(entity.name ?? '').toLowerCase().includes(needle)) return false;
  }
  if (criteria.isToken !== undefined) {
    if (Boolean(entity.isToken) !== criteria.isToken) return false;
  }
  if (criteria.isVerified !== undefined) {
    if (Boolean(entity.isVerified) !== criteria.isVerified) return false;
  }
  if (criteria.minSafetyScore !== undefined) {
    if (typeof entity.safetyScore !== 'number' || entity.safetyScore < criteria.minSafetyScore) {
      return false;
    }
  }

  return true;
}

/** Return every entity in `entities` that matches `search`. */
export function matchEntities(
  search: Pick<SavedSearchRecord, 'targetType' | 'criteria'>,
  entities: MatchableEntity[],
): MatchableEntity[] {
  return entities.filter((entity) => matchesCriteria(search.targetType, search.criteria, entity));
}

/** Build the match payload delivered for a single matching row. */
export function buildSavedSearchMatch(
  search: SavedSearchRecord,
  entity: MatchableEntity,
  matchedAt: Date = new Date(),
): SavedSearchMatch {
  return {
    searchId: search.id,
    userId: search.userId,
    searchName: search.name,
    targetType: search.targetType,
    entity,
    matchedAt,
  };
}

function describeEntity(entity: MatchableEntity): string {
  if (entity.targetType === 'event') {
    const symbol = entity.topicSymbol ? ` (${entity.topicSymbol})` : '';
    return `Event ${entity.eventType ?? 'unknown'}${symbol} from ${entity.contractAddress ?? 'unknown'}`;
  }
  const label = entity.name ?? entity.contractAddress ?? 'unknown';
  return `Contract ${label}`;
}

export interface DeliveryResult {
  webhook: boolean;
  slack: boolean;
  push: boolean;
}

export interface SavedSearchNotifierDeps {
  notificationService?: NotificationService;
  /** Default webhook for every match, in addition to a per-search URL. */
  operatorWebhookUrl?: string;
  /** Slack webhook fan-out (enabled per search via notify.slack). */
  slackWebhookUrl?: string;
  /** Per-request timeout for outbound webhooks. */
  timeoutMs?: number;
}

/**
 * Delivers matched saved searches over the configured channels. Every outbound
 * request goes through the SSRF guard; failures are logged and never throw so a
 * single bad destination cannot stall the runner.
 */
export class SavedSearchNotifier {
  private readonly notificationService?: NotificationService;
  private readonly operatorWebhookUrl?: string;
  private readonly slackWebhookUrl?: string;
  private readonly timeoutMs: number;

  constructor(deps: SavedSearchNotifierDeps = {}) {
    this.notificationService = deps.notificationService;
    this.operatorWebhookUrl = deps.operatorWebhookUrl ?? process.env.ALERT_WEBHOOK_URL;
    this.slackWebhookUrl = deps.slackWebhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    this.timeoutMs = deps.timeoutMs ?? 5000;
  }

  async notifyMatch(
    search: SavedSearchRecord,
    entity: MatchableEntity,
    devices: PushDevice[] = [],
  ): Promise<DeliveryResult> {
    const match = buildSavedSearchMatch(search, entity);
    const result: DeliveryResult = { webhook: false, slack: false, push: false };

    const body = JSON.stringify({
      searchId: match.searchId,
      searchName: match.searchName,
      userId: match.userId,
      targetType: match.targetType,
      entity: match.entity,
      matchedAt: match.matchedAt.toISOString(),
    });

    const webhookTargets = [search.notify.webhookUrl, this.operatorWebhookUrl].filter(
      (url): url is string => Boolean(url),
    );
    for (const url of webhookTargets) {
      try {
        await safePost(url, body, { 'Content-Type': 'application/json' }, this.timeoutMs);
        result.webhook = true;
      } catch (err) {
        logger.error('[SavedSearch] Webhook delivery failed:', err);
      }
    }

    if (search.notify.slack && this.slackWebhookUrl) {
      try {
        await safePost(
          this.slackWebhookUrl,
          JSON.stringify({
            text: `Saved search "${search.name}" matched: ${describeEntity(entity)}`,
          }),
          { 'Content-Type': 'application/json' },
          this.timeoutMs,
        );
        result.slack = true;
      } catch (err) {
        logger.error('[SavedSearch] Slack delivery failed:', err);
      }
    }

    if (search.notify.push && this.notificationService && devices.length > 0) {
      try {
        await this.notificationService.send({
          title: `Saved search: ${search.name}`,
          body: describeEntity(entity),
          data: { searchId: search.id, targetType: search.targetType },
          groupKey: `saved_search_${search.id}`,
          category: 'saved_search',
          severity: 'low',
          devices,
        });
        result.push = true;
      } catch (err) {
        logger.error('[SavedSearch] Push delivery failed:', err);
      }
    }

    return result;
  }
}
