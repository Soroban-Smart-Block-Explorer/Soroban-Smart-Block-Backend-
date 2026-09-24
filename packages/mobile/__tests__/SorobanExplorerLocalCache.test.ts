import { describe, it, expect, beforeEach } from 'vitest';
import { SorobanExplorerLocalCache } from '../src/SorobanExplorerLocalCache';
import { EntityRef } from '../src/types';

class MemoryStorage {
  store = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const contractRef: EntityRef = { type: 'contract', id: 'C_CONTRACT' };
const walletRef: EntityRef = { type: 'wallet', id: 'G_WALLET' };

describe('SorobanExplorerLocalCache', () => {
  let storage: MemoryStorage;
  let cache: SorobanExplorerLocalCache;

  beforeEach(async () => {
    storage = new MemoryStorage();
    cache = new SorobanExplorerLocalCache(storage);
    await cache.initialize();
  });

  describe('recent searches', () => {
    it('records searches newest-first and trims whitespace', async () => {
      await cache.recordSearch('  usdc  ');
      await cache.recordSearch('xlm');
      expect(cache.getRecentSearches().map((s) => s.query)).toEqual(['xlm', 'usdc']);
    });

    it('dedupes case-insensitively and moves the entry to the front', async () => {
      await cache.recordSearch('USDC');
      await cache.recordSearch('xlm');
      await cache.recordSearch('usdc');
      expect(cache.getRecentSearches().map((s) => s.query)).toEqual(['usdc', 'xlm']);
    });

    it('ignores empty queries and caps the history', async () => {
      const small = new SorobanExplorerLocalCache(storage, { maxRecentSearches: 2 });
      await small.initialize();
      await small.recordSearch('   ');
      await small.recordSearch('a');
      await small.recordSearch('b');
      await small.recordSearch('c');
      expect(small.getRecentSearches().map((s) => s.query)).toEqual(['c', 'b']);
    });

    it('persists searches across instances', async () => {
      await cache.recordSearch('usdc', 12);
      const reloaded = new SorobanExplorerLocalCache(storage);
      await reloaded.initialize();
      expect(reloaded.getRecentSearches()).toEqual([
        expect.objectContaining({ query: 'usdc', resultCount: 12 }),
      ]);
    });

    it('removes a single search and clears the history', async () => {
      await cache.recordSearch('usdc');
      await cache.recordSearch('xlm');
      await cache.removeSearch('USDC');
      expect(cache.getRecentSearches().map((s) => s.query)).toEqual(['xlm']);
      await cache.clearRecentSearches();
      expect(cache.getRecentSearches()).toEqual([]);
    });
  });

  describe('watchlist', () => {
    it('adds, detects, and removes entries', async () => {
      await cache.addToWatchlist(contractRef, 'USDC');
      expect(cache.isWatched(contractRef)).toBe(true);
      expect(cache.getWatchlist()).toEqual([
        expect.objectContaining({ type: 'contract', id: 'C_CONTRACT', label: 'USDC' }),
      ]);

      await cache.removeFromWatchlist(contractRef);
      expect(cache.isWatched(contractRef)).toBe(false);
      expect(cache.getWatchlist()).toEqual([]);
    });

    it('does not duplicate an existing entry', async () => {
      await cache.addToWatchlist(contractRef);
      await cache.addToWatchlist(contractRef, 'USDC');
      expect(cache.getWatchlist()).toHaveLength(1);
      expect(cache.getWatchlist()[0].label).toBe('USDC');
    });

    it('toggles an entry and reports the resulting state', async () => {
      expect(await cache.toggleWatchlist(walletRef)).toBe(true);
      expect(await cache.toggleWatchlist(walletRef)).toBe(false);
      expect(cache.isWatched(walletRef)).toBe(false);
    });
  });

  describe('last viewed', () => {
    it('dedupes by ref and keeps the newest first', async () => {
      await cache.recordView(contractRef, 'USDC');
      await cache.recordView(walletRef, 'Main');
      await cache.recordView(contractRef, 'USDC v2');
      expect(cache.getLastViewed().map((e) => e.id)).toEqual(['C_CONTRACT', 'G_WALLET']);
      expect(cache.getLastViewed()[0].label).toBe('USDC v2');
    });

    it('filters by entity type', async () => {
      await cache.recordView(contractRef);
      await cache.recordView(walletRef);
      expect(cache.getLastViewed('wallet').map((e) => e.id)).toEqual(['G_WALLET']);
    });

    it('caps the number of remembered entities', async () => {
      const small = new SorobanExplorerLocalCache(storage, { maxLastViewed: 1 });
      await small.initialize();
      await small.recordView(contractRef);
      await small.recordView(walletRef);
      expect(small.getLastViewed().map((e) => e.id)).toEqual(['G_WALLET']);
    });
  });

  describe('hydration', () => {
    it('collects deduped refs across watchlist and history', async () => {
      await cache.addToWatchlist(contractRef);
      await cache.recordView(walletRef);
      await cache.recordView(contractRef);
      expect(cache.getHydrationRefs()).toEqual([contractRef, walletRef]);
    });

    it('caps the number of refs sent for hydration', async () => {
      const small = new SorobanExplorerLocalCache(storage, { maxHydrationRefs: 1 });
      await small.initialize();
      await small.addToWatchlist(contractRef);
      await small.recordView(walletRef);
      expect(small.getHydrationRefs()).toHaveLength(1);
    });

    it('applies summaries and fills in missing labels', async () => {
      await cache.addToWatchlist(contractRef);
      await cache.applyHydration([
        {
          type: 'contract',
          id: 'C_CONTRACT',
          label: 'USD Coin',
          sublabel: 'USDC',
          status: 'verified',
        },
      ]);
      expect(cache.getWatchlist()[0]).toEqual(
        expect.objectContaining({
          label: 'USD Coin',
          summary: expect.objectContaining({ status: 'verified' }),
        }),
      );
    });

    it('hydrates through the injected fetcher', async () => {
      await cache.addToWatchlist(contractRef);
      await cache.recordView(walletRef);
      const fetcher = async (refs: EntityRef[]) =>
        refs.map((ref) => ({ ...ref, label: `Label ${ref.id}` }));

      const summaries = await cache.hydrate(fetcher);
      expect(summaries).toHaveLength(2);
      expect(cache.getLastViewed()[0].summary?.label).toBe('Label G_WALLET');
    });

    it('does not call the fetcher when nothing is persisted', async () => {
      let called = false;
      await cache.hydrate(async () => {
        called = true;
        return [];
      });
      expect(called).toBe(false);
    });
  });

  describe('state management', () => {
    it('recovers from corrupted storage', async () => {
      const corrupt = new MemoryStorage();
      await corrupt.setItem('soroban_local_state', '{not json');
      const c = new SorobanExplorerLocalCache(corrupt);
      await c.initialize();
      expect(c.getRecentSearches()).toEqual([]);
      expect(c.getWatchlist()).toEqual([]);
    });

    it('notifies listeners on change', async () => {
      const states: number[] = [];
      cache.onStateChange((state) => states.push(state.recentSearches.length));
      await cache.recordSearch('usdc');
      expect(states[states.length - 1]).toBe(1);
    });

    it('clears everything from memory and storage', async () => {
      await cache.recordSearch('usdc');
      await cache.addToWatchlist(contractRef);
      await cache.clear();
      expect(cache.getRecentSearches()).toEqual([]);
      expect(cache.getWatchlist()).toEqual([]);
      expect(await storage.getItem('soroban_local_state')).toBeNull();
    });
  });
});
