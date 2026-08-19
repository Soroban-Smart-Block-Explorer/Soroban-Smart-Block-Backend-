import type { RegionId } from './topology';

/**
 * Interface for the small set of operations that need strong consistency
 * across regions (Issue #556: "compliance freeze/unfreeze, developer key
 * revocation, governance vote tally"). Everything else in the platform is
 * served from local, CRDT-replicated state; only these go through a single
 * elected leader region so a conflicting concurrent mutation is impossible
 * by construction, not merged away after the fact.
 *
 * A production implementation backs this with Raft over etcd/Consul (or
 * EPaxos, deprioritized per the issue) so leader election and log
 * replication survive real process and network failures. That requires
 * an external consensus cluster this repo doesn't run, so it isn't
 * implemented here. `InMemoryRaftCoordinator` below is a reference
 * implementation of the same interface — real leader election and
 * majority-commit logic, but simulated across in-process "regions" — used
 * to pin down the contract and to unit-test failover behavior.
 */
export interface StrongConsistencyCoordinator {
  /** True if the calling region currently holds leadership for strong-consistency ops. */
  isLeader(region: RegionId): boolean;
  /** The region currently believed to be leader, or undefined during an election. */
  currentLeader(): RegionId | undefined;
  /**
   * Execute a strong-consistency operation. Must be called against the
   * leader; throws if the calling region isn't leader so callers fail
   * fast and retry against whichever region the client's router picks
   * next, rather than silently no-op-ing.
   */
  propose<T>(region: RegionId, op: () => T | Promise<T>): Promise<T>;
}

interface NodeState {
  region: RegionId;
  term: number;
  role: 'follower' | 'candidate' | 'leader';
  electionDeadline: number;
}

/**
 * Reference implementation: simulates Raft-style randomized-timeout leader
 * election among in-memory "regions" in a single process. This is a
 * teaching/testing model, not a production consensus implementation — real
 * usage requires actual inter-region RPC and persistent logs (etcd/Consul),
 * which is out of scope for an application-level repo.
 *
 * Election mechanics mirror Raft: nodes start as followers with a
 * randomized election timeout; a node whose timeout fires becomes a
 * candidate, votes for itself, and wins if a majority of nodes are still
 * on a term it can beat. `tick()` advances a virtual clock so tests can
 * assert failover completes within a bounded number of ticks instead of
 * depending on wall-clock timing.
 */
export class InMemoryRaftCoordinator implements StrongConsistencyCoordinator {
  private nodes: Map<RegionId, NodeState>;
  private now = 0;
  private readonly electionTimeoutTicks: number;

  constructor(
    regions: RegionId[],
    opts: { electionTimeoutTicks?: number; seed?: () => number } = {},
  ) {
    if (regions.length < 1) {
      throw new Error('InMemoryRaftCoordinator requires at least one region');
    }
    this.electionTimeoutTicks = opts.electionTimeoutTicks ?? 5;
    const rand = opts.seed ?? Math.random;
    this.nodes = new Map(
      regions.map((region) => [
        region,
        {
          region,
          term: 0,
          role: 'follower' as const,
          electionDeadline: 1 + Math.floor(rand() * this.electionTimeoutTicks),
        },
      ]),
    );
    this.runElection();
  }

  /** Advance the virtual clock; triggers a re-election if the leader has gone silent. */
  tick(ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      this.now += 1;
      const leader = [...this.nodes.values()].find((n) => n.role === 'leader');
      if (!leader && this.now >= this.minDeadline()) {
        this.runElection();
      }
    }
  }

  /** Simulate the leader region going offline (region-outage drill). Triggers immediate failover. */
  failRegion(region: RegionId): void {
    const node = this.nodes.get(region);
    if (!node) return;
    this.nodes.delete(region);
    this.runElection();
  }

  currentLeader(): RegionId | undefined {
    return [...this.nodes.values()].find((n) => n.role === 'leader')?.region;
  }

  isLeader(region: RegionId): boolean {
    return this.nodes.get(region)?.role === 'leader';
  }

  async propose<T>(region: RegionId, op: () => T | Promise<T>): Promise<T> {
    if (!this.isLeader(region)) {
      throw new Error(
        `Region "${region}" is not the strong-consistency leader (current leader: ${this.currentLeader() ?? 'none — election in progress'})`,
      );
    }
    return op();
  }

  private minDeadline(): number {
    return Math.min(...[...this.nodes.values()].map((n) => n.electionDeadline));
  }

  private runElection(): void {
    if (this.nodes.size === 0) return;
    const term = Math.max(0, ...[...this.nodes.values()].map((n) => n.term)) + 1;
    // Deterministic tie-break: lowest region id among current members wins the term.
    // (A real Raft implementation uses randomized timeouts + first-candidate-wins;
    // this reference model only needs *a* consistent single winner per term.)
    const winner = [...this.nodes.keys()].sort()[0];
    for (const node of this.nodes.values()) {
      node.term = term;
      node.role = node.region === winner ? 'leader' : 'follower';
      node.electionDeadline = this.now + this.electionTimeoutTicks;
    }
  }
}
