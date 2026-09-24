import {
  EntityRef,
  HydrationEntitySummary,
  LastViewedEntity,
  PersistedLocalState,
  RecentSearch,
  WatchlistEntry,
} from './types';

/**
 * Minimal async key-value store injected by the host platform
 * (AsyncStorage / MMKV / localStorage / SecureStore). Keeping the SDK
 * platform-agnostic mirrors the provider pattern used by the other modules.
 */
export interface KeyValueStorageProvider {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Optional limits for the on-device caches. */
export interface LocalCacheConfig {
  /** Storage key the state snapshot is written to. */
  storageKey?: string;
  /** Maximum remembered search queries (most recent first). */
  maxRecentSearches?: number;
  /** Maximum remembered last-viewed entities. */
  maxLastViewed?: number;
  /** Maximum watchlist entries. */
  maxWatchlist?: number;
  /** Maximum refs sent to the hydration endpoint in one request. */
  maxHydrationRefs?: number;
}

const DEFAULTS: Required<LocalCacheConfig> = {
  storageKey: 'soroban_local_state',
  maxRecentSearches: 20,
  maxLastViewed: 30,
  maxWatchlist: 100,
  maxHydrationRefs: 50,
};

const STATE_VERSION = 1;

function emptyState(): PersistedLocalState {
  return { version: STATE_VERSION, recentSearches: [], watchlist: [], lastViewed: [] };
}

function keyOf(ref: EntityRef): string {
  return `${ref.type}:${ref.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseState(raw: string | null): PersistedLocalState {
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyState();
    return {
      version: typeof parsed.version === 'number' ? parsed.version : STATE_VERSION,
      recentSearches: Array.isArray(parsed.recentSearches)
        ? (parsed.recentSearches as RecentSearch[])
        : [],
      watchlist: Array.isArray(parsed.watchlist) ? (parsed.watchlist as WatchlistEntry[]) : [],
      lastViewed: Array.isArray(parsed.lastViewed) ? (parsed.lastViewed as LastViewedEntity[]) : [],
    };
  } catch {
    return emptyState();
  }
}

/**
 * On-device persistence for the explorer's lightweight navigation state:
 * recent searches, the active watchlist, and the last entities the user opened.
 *
 * The stored snapshot is the source of truth when the device is offline; the
 * hydration endpoint only enriches entries with small display summaries.
 */
export class SorobanExplorerLocalCache {
  private storage: KeyValueStorageProvider;
  private config: Required<LocalCacheConfig>;
  private state: PersistedLocalState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();
  private listeners: Set<(state: PersistedLocalState) => void> = new Set();

  constructor(storage: KeyValueStorageProvider, config: LocalCacheConfig = {}) {
    this.storage = storage;
    this.config = { ...DEFAULTS, ...config };
  }

  /** Loads the persisted snapshot into memory. Safe to call more than once. */
  async initialize(): Promise<void> {
    const raw = await this.storage.getItem(this.config.storageKey).catch(() => null);
    this.state = parseState(raw);
    this.emit();
  }

  // ── Recent searches ────────────────────────────────────────────────────────

  async recordSearch(query: string, resultCount?: number): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;

    const normalized = trimmed.toLowerCase();
    this.state.recentSearches = this.state.recentSearches.filter(
      (entry) => entry.query.trim().toLowerCase() !== normalized,
    );

    const entry: RecentSearch = { query: trimmed, searchedAt: new Date().toISOString() };
    if (resultCount !== undefined) entry.resultCount = resultCount;

    this.state.recentSearches.unshift(entry);
    this.state.recentSearches = this.state.recentSearches.slice(0, this.config.maxRecentSearches);

    await this.persist();
    this.emit();
  }

  getRecentSearches(): RecentSearch[] {
    return this.state.recentSearches.map((entry) => ({ ...entry }));
  }

  async removeSearch(query: string): Promise<void> {
    const normalized = query.trim().toLowerCase();
    const next = this.state.recentSearches.filter(
      (entry) => entry.query.trim().toLowerCase() !== normalized,
    );
    if (next.length === this.state.recentSearches.length) return;
    this.state.recentSearches = next;
    await this.persist();
    this.emit();
  }

  async clearRecentSearches(): Promise<void> {
    if (this.state.recentSearches.length === 0) return;
    this.state.recentSearches = [];
    await this.persist();
    this.emit();
  }

  // ── Watchlist ──────────────────────────────────────────────────────────────

  async addToWatchlist(ref: EntityRef, label?: string): Promise<void> {
    const key = keyOf(ref);
    const existing = this.state.watchlist.find((entry) => keyOf(entry) === key);
    if (existing) {
      if (label !== undefined) existing.label = label;
      await this.persist();
      this.emit();
      return;
    }

    const entry: WatchlistEntry = {
      type: ref.type,
      id: ref.id,
      addedAt: new Date().toISOString(),
    };
    if (label !== undefined) entry.label = label;

    this.state.watchlist.unshift(entry);
    this.state.watchlist = this.state.watchlist.slice(0, this.config.maxWatchlist);

    await this.persist();
    this.emit();
  }

  async removeFromWatchlist(ref: EntityRef): Promise<void> {
    const key = keyOf(ref);
    const next = this.state.watchlist.filter((entry) => keyOf(entry) !== key);
    if (next.length === this.state.watchlist.length) return;
    this.state.watchlist = next;
    await this.persist();
    this.emit();
  }

  /** Adds the ref if absent, removes it if present. Returns whether it is watched. */
  async toggleWatchlist(ref: EntityRef, label?: string): Promise<boolean> {
    if (this.isWatched(ref)) {
      await this.removeFromWatchlist(ref);
      return false;
    }
    await this.addToWatchlist(ref, label);
    return true;
  }

  isWatched(ref: EntityRef): boolean {
    const key = keyOf(ref);
    return this.state.watchlist.some((entry) => keyOf(entry) === key);
  }

  getWatchlist(): WatchlistEntry[] {
    return this.state.watchlist.map((entry) => ({ ...entry }));
  }

  async clearWatchlist(): Promise<void> {
    if (this.state.watchlist.length === 0) return;
    this.state.watchlist = [];
    await this.persist();
    this.emit();
  }

  // ── Last viewed ────────────────────────────────────────────────────────────

  async recordView(ref: EntityRef, label?: string): Promise<void> {
    const key = keyOf(ref);
    const existing = this.state.lastViewed.find((entry) => keyOf(entry) === key);
    const summary = existing?.summary;

    const entry: LastViewedEntity = {
      type: ref.type,
      id: ref.id,
      viewedAt: new Date().toISOString(),
    };
    const resolvedLabel = label ?? existing?.label;
    if (resolvedLabel !== undefined) entry.label = resolvedLabel;
    if (summary !== undefined) entry.summary = summary;

    this.state.lastViewed = this.state.lastViewed.filter((item) => keyOf(item) !== key);
    this.state.lastViewed.unshift(entry);
    this.state.lastViewed = this.state.lastViewed.slice(0, this.config.maxLastViewed);

    await this.persist();
    this.emit();
  }

  getLastViewed(type?: EntityRef['type']): LastViewedEntity[] {
    const items = type
      ? this.state.lastViewed.filter((entry) => entry.type === type)
      : this.state.lastViewed;
    return items.map((entry) => ({ ...entry }));
  }

  async clearLastViewed(): Promise<void> {
    if (this.state.lastViewed.length === 0) return;
    this.state.lastViewed = [];
    await this.persist();
    this.emit();
  }

  // ── Hydration ──────────────────────────────────────────────────────────────

  /** Refs to request from the hydration endpoint: watchlist first, then views. */
  getHydrationRefs(): EntityRef[] {
    const seen = new Set<string>();
    const refs: EntityRef[] = [];
    const push = (ref: EntityRef) => {
      const key = keyOf(ref);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ type: ref.type, id: ref.id });
    };

    this.state.watchlist.forEach(push);
    this.state.lastViewed.forEach(push);

    return refs.slice(0, this.config.maxHydrationRefs);
  }

  /** Merges server summaries into the watchlist and last-viewed entries. */
  async applyHydration(summaries: HydrationEntitySummary[]): Promise<void> {
    if (summaries.length === 0) return;

    const byKey = new Map<string, HydrationEntitySummary>();
    for (const summary of summaries) byKey.set(keyOf(summary), summary);

    for (const entry of [...this.state.watchlist, ...this.state.lastViewed]) {
      const summary = byKey.get(keyOf(entry));
      if (!summary) continue;
      entry.summary = summary;
      if (!entry.label) entry.label = summary.label;
    }

    await this.persist();
    this.emit();
  }

  /**
   * Fetches small summaries for the persisted refs and merges them in.
   * The fetcher is typically `SorobanExplorerClient.getHydrationEntities`.
   */
  async hydrate(
    fetchSummaries: (refs: EntityRef[]) => Promise<HydrationEntitySummary[]>,
  ): Promise<HydrationEntitySummary[]> {
    const refs = this.getHydrationRefs();
    if (refs.length === 0) return [];

    const summaries = await fetchSummaries(refs);
    await this.applyHydration(summaries);
    return summaries;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  getState(): PersistedLocalState {
    return {
      version: this.state.version,
      recentSearches: this.state.recentSearches.map((entry) => ({ ...entry })),
      watchlist: this.state.watchlist.map((entry) => ({ ...entry })),
      lastViewed: this.state.lastViewed.map((entry) => ({ ...entry })),
    };
  }

  onStateChange(callback: (state: PersistedLocalState) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Clears all persisted state from memory and from the device. */
  async clear(): Promise<void> {
    this.state = emptyState();
    await this.writeChain.catch(() => undefined);
    this.writeChain = this.storage.removeItem(this.config.storageKey).catch(() => undefined);
    await this.writeChain;
    this.emit();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.storage.setItem(this.config.storageKey, snapshot));
    return this.writeChain;
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((callback) => callback(snapshot));
  }
}
