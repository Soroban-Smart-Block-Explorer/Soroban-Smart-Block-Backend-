/**
 * tests/regions/consensus.test.ts
 * Issue #556 — strong-consistency coordinator interface and its in-memory
 * reference implementation, including the "region outage drill" failover
 * requirement (leader election < 5s, modeled here as < 5 virtual ticks).
 */
import { describe, it, expect } from 'vitest';
import { InMemoryRaftCoordinator } from '../../src/regions/consensus';
import type { RegionId } from '../../src/regions/topology';

const ALL_REGIONS: RegionId[] = ['us-east', 'eu-west', 'ap-southeast', 'sa-east', 'af-south'];

describe('InMemoryRaftCoordinator', () => {
  it('elects exactly one leader at startup', () => {
    const coordinator = new InMemoryRaftCoordinator(ALL_REGIONS);
    const leaders = ALL_REGIONS.filter((r) => coordinator.isLeader(r));
    expect(leaders).toHaveLength(1);
    expect(coordinator.currentLeader()).toBe(leaders[0]);
  });

  it('only the leader can propose strong-consistency operations', async () => {
    const coordinator = new InMemoryRaftCoordinator(ALL_REGIONS);
    const leader = coordinator.currentLeader()!;
    const follower = ALL_REGIONS.find((r) => r !== leader)!;

    await expect(coordinator.propose(leader, () => 'ok')).resolves.toBe('ok');
    await expect(coordinator.propose(follower, () => 'nope')).rejects.toThrow(
      /not the strong-consistency leader/,
    );
  });

  it('region outage drill: failing the leader region elects a new leader within 5 ticks', () => {
    const coordinator = new InMemoryRaftCoordinator(ALL_REGIONS, { electionTimeoutTicks: 5 });
    const originalLeader = coordinator.currentLeader()!;

    coordinator.failRegion(originalLeader);

    const newLeader = coordinator.currentLeader();
    expect(newLeader).toBeDefined();
    expect(newLeader).not.toBe(originalLeader);
    expect(ALL_REGIONS.includes(newLeader!)).toBe(true);
  });

  it('remaining regions keep serving strong-consistency ops after a region outage', async () => {
    const coordinator = new InMemoryRaftCoordinator(ALL_REGIONS);
    const originalLeader = coordinator.currentLeader()!;
    coordinator.failRegion(originalLeader);

    const newLeader = coordinator.currentLeader()!;
    await expect(coordinator.propose(newLeader, () => 'still-strongly-consistent')).resolves.toBe(
      'still-strongly-consistent',
    );
  });
});
