/**
 * Tests for #489: Build queue resource exhaustion protection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConcurrencyLimit,
  getResourceQuota,
  pushBuildJob,
} from '../src/api/build-queue';

describe('Build Queue - Resource Quotas', () => {
  beforeEach(() => {
    // Reset state between tests
  });

  it('returns zero concurrency for unauthenticated and free tiers', () => {
    expect(getConcurrencyLimit('unauthenticated')).toBe(0);
    expect(getConcurrencyLimit('free')).toBe(0);
  });

  it('returns correct concurrency limits for paid tiers', () => {
    expect(getConcurrencyLimit('developer')).toBe(2);
    expect(getConcurrencyLimit('pro')).toBe(5);
    expect(getConcurrencyLimit('enterprise')).toBe(10);
  });

  it('returns correct resource quotas per tier', () => {
    const devQuota = getResourceQuota('developer');
    expect(devQuota.memoryMb).toBe(1024);
    expect(devQuota.timeoutSec).toBe(120);

    const proQuota = getResourceQuota('pro');
    expect(proQuota.memoryMb).toBe(2048);
    expect(proQuota.timeoutSec).toBe(180);

    const entQuota = getResourceQuota('enterprise');
    expect(entQuota.memoryMb).toBe(4096);
    expect(entQuota.timeoutSec).toBe(240);
  });

  it('rejects build jobs for unauthenticated/free tiers', async () => {
    await expect(pushBuildJob('unauthenticated')).rejects.toThrow(
      'Build jobs not allowed for this tier',
    );
    await expect(pushBuildJob('free')).rejects.toThrow('Build jobs not allowed for this tier');
  });
});
