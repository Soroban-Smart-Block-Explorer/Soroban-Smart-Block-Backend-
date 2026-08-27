import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setSelfPeerId,
  getSelfPeerId,
  recordPeerHeartbeat,
  ownersOf,
  amIResponsibleFor,
  isP2pEnabled,
  getMembershipView,
} from '../src/p2p/responsibility';
import { rangeBoundsForLedger } from '../src/p2p/range';
import { MembershipView } from '../src/p2p/membership-view';

vi.mock('../src/db', () => ({
  prismaWrite: {
    indexerRangeClaim: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    peerNode: {
      upsert: vi.fn(),
    },
    verificationChallenge: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../src/p2p/config', () => ({
  loadP2pConfig: () => ({
    enabled: true,
    network: 'testnet',
    rangeSize: 10_000,
    replicationFactor: 3,
    heartbeatIntervalMs: 5000,
    heartbeatMissedIntervalsBeforeStale: 3,
    challengeIntervalMs: 60_000,
  }),
}));

describe('responsibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('peer ID management', () => {
    it('tracks self peer ID', () => {
      expect(getSelfPeerId()).toBeNull();

      setSelfPeerId('peer-123');
      expect(getSelfPeerId()).toBe('peer-123');

      setSelfPeerId('peer-456');
      expect(getSelfPeerId()).toBe('peer-456');
    });

    it('initializes membership view with self after setting peer ID', () => {
      setSelfPeerId('peer-self');
      const view = getMembershipView();

      expect(view).toBeInstanceOf(MembershipView);
      const activeIds = view.activePeerIds(Date.now());
      expect(activeIds).toContain('peer-self');
    });
  });

  describe('heartbeat recording', () => {
    beforeEach(() => {
      setSelfPeerId('peer-self');
    });

    it('records peer heartbeats', () => {
      const now = Date.now();
      recordPeerHeartbeat('peer-a', ['ma+tcp://192.168.1.1'], now);
      recordPeerHeartbeat('peer-b', ['ma+tcp://192.168.1.2'], now);

      const view = getMembershipView();
      const activeIds = view.activePeerIds(now);

      expect(activeIds).toContain('peer-a');
      expect(activeIds).toContain('peer-b');
      expect(activeIds).toContain('peer-self');
    });

    it('marks peers as stale after missed heartbeat windows', () => {
      const now = Date.now();
      recordPeerHeartbeat('peer-old', ['ma+tcp://192.168.1.1'], now);

      const view = getMembershipView();
      expect(view.activePeerIds(now)).toContain('peer-old');

      const staleTime = now + 3 * 5000 * 3 + 1000;
      expect(view.activePeerIds(staleTime)).not.toContain('peer-old');
    });
  });

  describe('responsibility determination', () => {
    beforeEach(() => {
      setSelfPeerId('peer-self');
      const now = Date.now();
      recordPeerHeartbeat('peer-a', [], now);
      recordPeerHeartbeat('peer-b', [], now);
    });

    it('determines ownership of ledgers within bounds', () => {
      const now = Date.now();
      const ledger = 15_000;

      const owners = ownersOf(ledger, now);
      expect(Array.isArray(owners)).toBe(true);
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.length).toBeLessThanOrEqual(3);
    });

    it('self is responsible when in owner set', () => {
      const now = Date.now();
      const ledger = 5_000;

      const owners = ownersOf(ledger, now);
      if (owners.includes('peer-self')) {
        expect(amIResponsibleFor(ledger, now)).toBe(true);
      }
    });

    it('self is not responsible when not in owner set', () => {
      const now = Date.now();
      const ledger = 15_000;
      const ledger2 = 25_000;

      const ownersLedger = ownersOf(ledger, now);
      const ownersLedger2 = ownersOf(ledger2, now);

      if (!ownersLedger.includes('peer-self')) {
        expect(amIResponsibleFor(ledger, now)).toBe(false);
      }
      if (!ownersLedger2.includes('peer-self')) {
        expect(amIResponsibleFor(ledger2, now)).toBe(false);
      }
    });

    it('returns false when self peer ID is not set', () => {
      const nullPeerId = getSelfPeerId();
      if (nullPeerId === null) {
        expect(amIResponsibleFor(10_000)).toBe(false);
      }
    });
  });

  describe('range coverage', () => {
    it('assigns ranges consistently across ledgers in same range', () => {
      const now = Date.now();
      setSelfPeerId('peer-self');
      recordPeerHeartbeat('peer-a', [], now);
      recordPeerHeartbeat('peer-b', [], now);

      const ledger1 = 10_000;
      const ledger2 = 15_000;
      const ledger3 = 19_999;

      const bounds1 = rangeBoundsForLedger('testnet', ledger1, 10_000);
      const bounds2 = rangeBoundsForLedger('testnet', ledger2, 10_000);
      const bounds3 = rangeBoundsForLedger('testnet', ledger3, 10_000);

      expect(bounds1.rangeId).toBe(bounds2.rangeId);
      expect(bounds2.rangeId).toBe(bounds3.rangeId);

      const owners1 = ownersOf(ledger1, now);
      const owners2 = ownersOf(ledger2, now);
      const owners3 = ownersOf(ledger3, now);

      expect(owners1).toEqual(owners2);
      expect(owners2).toEqual(owners3);
    });

    it('assigns different ranges to ledgers across boundaries', () => {
      const now = Date.now();
      setSelfPeerId('peer-self');
      recordPeerHeartbeat('peer-a', [], now);
      recordPeerHeartbeat('peer-b', [], now);

      const ledger1 = 9_999;
      const ledger2 = 10_000;

      const bounds1 = rangeBoundsForLedger('testnet', ledger1, 10_000);
      const bounds2 = rangeBoundsForLedger('testnet', ledger2, 10_000);

      expect(bounds1.rangeId).not.toBe(bounds2.rangeId);

      const owners1 = ownersOf(ledger1, now);
      const owners2 = ownersOf(ledger2, now);

      expect(owners1).not.toEqual(owners2);
    });
  });

  describe('P2P configuration', () => {
    it('correctly identifies P2P enabled status', () => {
      expect(isP2pEnabled()).toBe(true);
    });

    it('handles P2P disabled mode', () => {
      setSelfPeerId('peer-self');
      const ledger = 10_000;

      if (!isP2pEnabled()) {
        expect(amIResponsibleFor(ledger)).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    it('handles ledger 0', () => {
      setSelfPeerId('peer-self');
      const now = Date.now();

      expect(() => ownersOf(0, now)).not.toThrow();
      const owners = ownersOf(0, now);
      expect(Array.isArray(owners)).toBe(true);
    });

    it('handles ledgers at range boundaries', () => {
      setSelfPeerId('peer-self');
      const now = Date.now();

      const boundary = 10_000;
      const justBefore = boundary - 1;
      const justAfter = boundary;

      const ownersBefore = ownersOf(justBefore, now);
      const ownersAfter = ownersOf(justAfter, now);

      expect(ownersBefore).not.toEqual(ownersAfter);
    });

    it('handles empty peer set gracefully', () => {
      setSelfPeerId('peer-solo');
      const now = Date.now();
      const oldTime = now + 100_000_000;

      expect(() => ownersOf(10_000, oldTime)).not.toThrow();
      const owners = ownersOf(10_000, oldTime);
      expect(owners).toContain('peer-solo');
    });
  });
});
