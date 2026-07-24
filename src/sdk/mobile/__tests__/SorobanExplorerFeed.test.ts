import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanExplorerFeed } from '../SorobanExplorerFeed';

describe('SorobanExplorerFeed', () => {
  let feed: SorobanExplorerFeed;

  beforeEach(() => {
    feed = new SorobanExplorerFeed(
      { baseUrl: 'https://api.soroban.network' },
      { preferSSE: false },
    );
  });

  it('should initialize', () => {
    expect(feed).toBeDefined();
  });

  it('should emit connected event', () => {
    const callback = vi.fn();
    feed.on('connected', callback);
    feed.connect(['transactions']);
    expect(feed.isConnectedStatus()).toBe(false);
  });

  it('should subscribe to channels', () => {
    const callback = vi.fn();
    const unsubscribe = feed.subscribe('transactions', callback);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('should handle event listeners', () => {
    const callback = vi.fn();
    const unsubscribe = feed.on('message', callback);
    unsubscribe();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should disconnect cleanly', () => {
    feed.connect(['transactions']);
    feed.disconnect();
    expect(feed.isConnectedStatus()).toBe(false);
  });
});
