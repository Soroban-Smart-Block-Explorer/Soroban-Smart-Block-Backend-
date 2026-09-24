/**
 * Saved search runner.
 *
 * Drives the "match on new indexed data" half of the saved-search feature:
 * for each active SavedSearch it scans contracts/events indexed after the
 * search's `lastRunAt` cursor, applies the matcher, and delivers matches via
 * `SavedSearchNotifier` (push + webhook, reusing the alert delivery stack).
 *
 * The API's `POST /saved-searches/:id/run` calls `runSavedSearch` directly for
 * an on-demand check; `startSavedSearchScheduler` wires it into the indexer on
 * an interval.
 */

import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';
import { NotificationService } from '../notifications/notificationService';
import {
  MatchableEntity,
  PushDevice,
  SavedSearchCriteria,
  SavedSearchMatch,
  SavedSearchNotifier,
  SavedSearchRecord,
  SavedSearchRowLike,
  buildSavedSearchMatch,
  matchesCriteria,
  toSavedSearchRecord,
} from '../notifications/savedSearchMatcher';

/** How far back to look for a search that has never run. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_CONTRACTS_PER_RUN = 500;
const MAX_EVENTS_PER_RUN = 1000;

let sharedNotifier: SavedSearchNotifier | undefined;

/** Lazily build the process-wide notifier from environment configuration. */
export function getSavedSearchNotifier(): SavedSearchNotifier {
  if (!sharedNotifier) {
    sharedNotifier = new SavedSearchNotifier({
      notificationService: new NotificationService({
        fcmApiKey: process.env.FCM_API_KEY,
        apnsKey: process.env.APNS_KEY,
        vapidKeys:
          process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
            ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
            : undefined,
      }),
    });
  }
  return sharedNotifier;
}

async function fetchContractEntities(since: Date): Promise<MatchableEntity[]> {
  const rows = await prismaRead.contract.findMany({
    where: { createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: MAX_CONTRACTS_PER_RUN,
    select: {
      address: true,
      name: true,
      isToken: true,
      isVerified: true,
      safetyScore: true,
    },
  });
  return rows.map((row) => ({
    targetType: 'contract' as const,
    contractAddress: row.address,
    name: row.name ?? undefined,
    isToken: row.isToken,
    isVerified: row.isVerified,
    safetyScore: row.safetyScore,
  }));
}

async function fetchEventEntities(since: Date): Promise<MatchableEntity[]> {
  const rows = await prismaRead.event.findMany({
    where: { createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: MAX_EVENTS_PER_RUN,
    select: {
      contractAddress: true,
      eventType: true,
      topicSymbol: true,
    },
  });
  return rows.map((row) => ({
    targetType: 'event' as const,
    contractAddress: row.contractAddress,
    eventType: row.eventType,
    topicSymbol: row.topicSymbol ?? undefined,
  }));
}

/** Fetch the role-relevant indexed rows created after `since`. */
export async function fetchNewEntities(
  targetType: SavedSearchRecord['targetType'],
  since: Date,
): Promise<MatchableEntity[]> {
  return targetType === 'event' ? fetchEventEntities(since) : fetchContractEntities(since);
}

export interface RunSavedSearchOptions {
  /** Override the cursor instead of using the search's `lastRunAt`. */
  since?: Date;
  /** Device tokens to fan push notifications out to. */
  devices?: PushDevice[];
  /** Injectable notifier (tests, or a caller with custom config). */
  notifier?: SavedSearchNotifier;
}

/**
 * Evaluate a single saved search against newly indexed data and deliver any
 * matches. Advances the search's `lastRunAt` cursor and records `lastMatchedAt`
 * / `lastError` so the next run stays incremental.
 */
export async function runSavedSearch(
  search: SavedSearchRecord,
  options: RunSavedSearchOptions = {},
): Promise<SavedSearchMatch[]> {
  const notifier = options.notifier ?? getSavedSearchNotifier();
  const since = options.since ?? search.lastRunAt ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);

  const entities = await fetchNewEntities(search.targetType, since);
  const matched = entities.filter((entity) =>
    matchesCriteria(search.targetType, search.criteria, entity),
  );

  const matches: SavedSearchMatch[] = [];
  for (const entity of matched) {
    matches.push(buildSavedSearchMatch(search, entity));
    await notifier.notifyMatch(search, entity, options.devices ?? []);
  }

  const now = new Date();
  await prismaWrite.savedSearch.update({
    where: { id: search.id },
    data: {
      lastRunAt: now,
      ...(matches.length > 0 ? { lastMatchedAt: now } : {}),
      lastError: null,
    },
  });

  return matches;
}

/**
 * Run every active saved search once. Failures are isolated per search so one
 * bad criteria/webhook cannot stop the batch.
 */
export async function runSavedSearches(): Promise<{ searches: number; matches: number }> {
  const rows = await prismaRead.savedSearch.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  let matches = 0;
  for (const row of rows) {
    const search = toSavedSearchRecord(row as SavedSearchRowLike);
    try {
      const found = await runSavedSearch(search);
      matches += found.length;
    } catch (err) {
      logger.error(`[SavedSearch] run failed for ${search.id}:`, err);
      await prismaWrite.savedSearch.update({
        where: { id: search.id },
        data: { lastError: (err as Error).message },
      });
    }
  }

  return { searches: rows.length, matches };
}

/**
 * Start a recurring saved-search job.
 * @param intervalMs How often to run (default: every 5 minutes).
 */
let schedulerTimer: NodeJS.Timeout | undefined;

export function startSavedSearchScheduler(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  // Idempotent: the indexer entrypoints (src/indexer/run.ts and
  // src/services.ts) both funnel through startIndexerService(), so guard
  // against scheduling the same job twice in one process.
  if (schedulerTimer) return schedulerTimer;

  runSavedSearches().catch((err) => logger.error('[savedSearches] initial run failed:', err));
  schedulerTimer = setInterval(() => {
    runSavedSearches().catch((err) => logger.error('[savedSearches] scheduled run failed:', err));
  }, intervalMs);
  return schedulerTimer;
}

/** Stop the recurring job. Safe to call when it was never started. */
export function stopSavedSearchScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  }
}

/** Re-exported for callers that only need the criteria type. */
export type { SavedSearchCriteria };
