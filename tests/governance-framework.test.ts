/**
 * Unit tests for the governance framework services (issue #567, Phase 2).
 * Pure logic — no database, no RPC. Strategy contexts are built from fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  getStrategy,
  supportedModels,
  canTransition,
  assertTransition,
  deriveStatus,
  isTerminal,
  canGuardianCancel,
  InvalidTransitionError,
  buildGraph,
  resolveVotingPower,
  subtractOverrides,
  hasDelegatedAway,
  graphSnapshot,
  MAX_DELEGATION_DEPTH,
  convictionNow,
  convictionThreshold,
  decayFactor,
  TokenWeightedStrategy,
  QuadraticStrategy,
  ConvictionStrategy,
  MultisigStrategy,
  toBigInt,
  type StrategyContext,
  type GovernanceConfig,
  type ProposalData,
  type DelegationEdge,
} from '../src/services/governance';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    contractAddress: 'CGOV1',
    governanceType: 'token_based',
    votingToken: 'CTOKEN1',
    quorumBps: 400, // 4%
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalData> = {}): ProposalData {
  return {
    contractAddress: 'CGOV1',
    proposalId: '1',
    proposer: 'GPROPOSER',
    status: 'active',
    startBlock: 100,
    endBlock: 200,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const balances: Record<string, bigint> = {
    GALICE: 1_000n,
    GBOB: 500n,
    GCAROL: 250n,
    GDAVE: 100n,
  };
  return {
    config: makeConfig(),
    proposal: makeProposal(),
    currentLedger: 150,
    totalSupply: 10_000n,
    getTokenBalance: async (holder: string) => balances[holder] ?? 0n,
    ...overrides,
  };
}

// ── Proposal lifecycle FSM ──────────────────────────────────────────────────

describe('proposal lifecycle FSM', () => {
  it('allows the happy path draft -> pending -> active -> queued -> executing -> executed', () => {
    expect(canTransition('draft', 'pending')).toBe(true);
    expect(canTransition('pending', 'active')).toBe(true);
    expect(canTransition('active', 'queued')).toBe(true);
    expect(canTransition('queued', 'executing')).toBe(true);
    expect(canTransition('executing', 'executed')).toBe(true);
  });

  it('rejects illegal transitions with a typed error', () => {
    expect(canTransition('draft', 'executed')).toBe(false);
    expect(canTransition('executed', 'active')).toBe(false);
    expect(canTransition('defeated', 'queued')).toBe(false);
    expect(() => assertTransition('draft', 'executed')).toThrow(InvalidTransitionError);
    try {
      assertTransition('queued', 'active');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).from).toBe('queued');
      expect((err as InvalidTransitionError).to).toBe('active');
    }
  });

  it('treats executed/defeated/failed/cancelled/expired as terminal', () => {
    for (const status of ['executed', 'defeated', 'failed', 'cancelled', 'expired'] as const) {
      expect(isTerminal(status)).toBe(true);
    }
    expect(isTerminal('active')).toBe(false);
  });

  it('derives pending -> active when the start ledger is reached', () => {
    expect(
      deriveStatus({
        stored: 'pending',
        model: 'token_based',
        currentLedger: 100,
        startBlock: 100,
        endBlock: 200,
      }),
    ).toBe('active');
    expect(
      deriveStatus({
        stored: 'pending',
        model: 'token_based',
        currentLedger: 99,
        startBlock: 100,
        endBlock: 200,
      }),
    ).toBe('pending');
  });

  it('never derives a transition out of a terminal state', () => {
    expect(
      deriveStatus({
        stored: 'cancelled',
        model: 'token_based',
        currentLedger: 9_999,
        startBlock: 100,
        endBlock: 200,
      }),
    ).toBe('cancelled');
  });

  it('expires queued proposals past their queue expiry ledger', () => {
    expect(
      deriveStatus({
        stored: 'queued',
        model: 'token_based',
        currentLedger: 301,
        startBlock: 100,
        endBlock: 200,
        queueExpiryLedger: 300,
      }),
    ).toBe('expired');
  });

  it('allows guardian cancel only before execution', () => {
    expect(canGuardianCancel('pending')).toBe(true);
    expect(canGuardianCancel('active')).toBe(true);
    expect(canGuardianCancel('queued')).toBe(true);
    expect(canGuardianCancel('executing')).toBe(false);
    expect(canGuardianCancel('executed')).toBe(false);
  });
});

// ── Strategy registry ───────────────────────────────────────────────────────

describe('strategy registry', () => {
  it('exposes all four governance models', () => {
    expect(supportedModels().sort()).toEqual(
      ['conviction', 'multisig', 'quadratic', 'token_based'].sort(),
    );
  });

  it('returns the matching strategy and throws on unknown models', () => {
    expect(getStrategy('token_based').model).toBe('token_based');
    expect(getStrategy('quadratic').model).toBe('quadratic');
    expect(() => getStrategy('futarchy')).toThrow(/Unknown governance model/);
  });
});

// ── Token-weighted strategy ─────────────────────────────────────────────────

describe('token-weighted strategy', () => {
  const strategy = new TokenWeightedStrategy();

  it('voting power = balance + inbound delegated power', async () => {
    const ctx = makeCtx({ getDelegatedPower: async () => 300n });
    expect(await strategy.getVotingPower(ctx, 'GALICE')).toBe(1_300n);
  });

  it('rejects votes outside the voting window', async () => {
    const early = await strategy.validateVote(makeCtx({ currentLedger: 50 }), {
      voter: 'GALICE',
      support: 'for',
    });
    expect(early.valid).toBe(false);
    expect(early.reason).toMatch(/not started/);

    const late = await strategy.validateVote(makeCtx({ currentLedger: 250 }), {
      voter: 'GALICE',
      support: 'for',
    });
    expect(late.valid).toBe(false);
    expect(late.reason).toMatch(/ended/);
  });

  it('rejects voters with zero power and over-weight votes', async () => {
    const noPower = await strategy.validateVote(makeCtx(), { voter: 'GNOBODY', support: 'for' });
    expect(noPower.valid).toBe(false);

    const tooMuch = await strategy.validateVote(makeCtx(), {
      voter: 'GBOB',
      support: 'for',
      amount: 501n,
    });
    expect(tooMuch.valid).toBe(false);
    expect(tooMuch.reason).toMatch(/exceeds/);
  });

  it('defaults the vote weight to full power', async () => {
    const result = await strategy.validateVote(makeCtx(), { voter: 'GALICE', support: 'for' });
    expect(result.valid).toBe(true);
    expect(result.weight).toBe(1_000n);
  });

  it('tallies weights per support bucket, skipping unknown', async () => {
    const tally = await strategy.tally(makeCtx(), [
      { voter: 'GALICE', support: 'for', weight: '1000' },
      { voter: 'GBOB', support: 'against', weight: '500' },
      { voter: 'GCAROL', support: 'abstain', weight: '250' },
      { voter: 'GEVE', support: 'unknown', weight: '99' },
    ]);
    expect(tally.for).toBe(1_000n);
    expect(tally.against).toBe(500n);
    expect(tally.abstain).toBe(250n);
    expect(tally.totalVoters).toBe(3);
  });

  it('stays pending while the window is open', () => {
    const tally = { for: 1_000n, against: 0n, abstain: 0n, totalVoters: 1 };
    expect(strategy.outcome(makeCtx({ currentLedger: 150 }), tally)).toBe('pending');
  });

  it('defeats a proposal missing quorum (bps of total supply)', () => {
    // 4% of 10_000 = 400; participation 300 < 400.
    const tally = { for: 200n, against: 50n, abstain: 50n, totalVoters: 3 };
    expect(strategy.outcome(makeCtx({ currentLedger: 250 }), tally)).toBe('defeated');
  });

  it('succeeds with quorum met and for > against; abstain counts to quorum only', () => {
    const tally = { for: 300n, against: 100n, abstain: 100n, totalVoters: 3 };
    expect(strategy.outcome(makeCtx({ currentLedger: 250 }), tally)).toBe('succeeded');

    const tied = { for: 200n, against: 200n, abstain: 100n, totalVoters: 3 };
    expect(strategy.outcome(makeCtx({ currentLedger: 250 }), tied)).toBe('defeated');
  });

  it('falls back to the proposal absolute quorum when no bps configured', () => {
    const ctx = makeCtx({
      currentLedger: 250,
      config: makeConfig({ quorumBps: null }),
      proposal: makeProposal({ quorum: '600' }),
    });
    const under = { for: 400n, against: 100n, abstain: 0n, totalVoters: 2 };
    expect(strategy.outcome(ctx, under)).toBe('defeated');
    const over = { for: 500n, against: 100n, abstain: 0n, totalVoters: 2 };
    expect(strategy.outcome(ctx, over)).toBe('succeeded');
  });
});

// ── Quadratic strategy ──────────────────────────────────────────────────────

describe('quadratic strategy', () => {
  const strategy = new QuadraticStrategy();

  function qvCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
    return makeCtx({
      config: makeConfig({
        governanceType: 'quadratic',
        voiceCreditsPerRound: 100,
        minTokenHolding: '100',
      }),
      ...overrides,
    });
  }

  it('costs N² credits for N votes', async () => {
    const result = await strategy.validateVote(qvCtx(), {
      voter: 'GALICE',
      support: 'for',
      votes: 7,
    });
    expect(result.valid).toBe(true);
    expect(result.weight).toBe(7n);
    expect(result.voiceCreditCost).toBe(49);
  });

  it('rejects votes exceeding the remaining budget (exhaustion)', async () => {
    const ctx = qvCtx({ getSpentVoiceCredits: async () => 64 });
    // 64 spent of 100 → 36 left → max 6 votes; 7 votes costs 49.
    const tooMany = await strategy.validateVote(ctx, { voter: 'GALICE', support: 'for', votes: 7 });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.reason).toMatch(/Insufficient voice credits/);
    const ok = await strategy.validateVote(ctx, { voter: 'GALICE', support: 'for', votes: 6 });
    expect(ok.valid).toBe(true);
  });

  it('enforces the Sybil floor: below min holding gets zero budget', async () => {
    // GDAVE holds 100 (at floor, allowed); GNOBODY holds 0.
    const atFloor = await strategy.validateVote(qvCtx(), {
      voter: 'GDAVE',
      support: 'for',
      votes: 2,
    });
    expect(atFloor.valid).toBe(true);
    const below = await strategy.validateVote(qvCtx(), {
      voter: 'GNOBODY',
      support: 'for',
      votes: 1,
    });
    expect(below.valid).toBe(false);
    expect(below.reason).toMatch(/minimum holding/i);
  });

  it('applies the optional reputation gate', async () => {
    const gated = qvCtx({
      config: makeConfig({
        governanceType: 'quadratic',
        voiceCreditsPerRound: 100,
        minReputationScore: 50,
      }),
      getReputationScore: async (voter: string) => (voter === 'GALICE' ? 80 : 10),
    });
    expect(
      (await strategy.validateVote(gated, { voter: 'GALICE', support: 'for', votes: 1 })).valid,
    ).toBe(true);
    expect(
      (await strategy.validateVote(gated, { voter: 'GBOB', support: 'for', votes: 1 })).valid,
    ).toBe(false);
  });

  it('rejects non-integer and non-positive vote counts', async () => {
    for (const votes of [0, -3, 2.5]) {
      const result = await strategy.validateVote(qvCtx(), {
        voter: 'GALICE',
        support: 'for',
        votes,
      });
      expect(result.valid).toBe(false);
    }
  });

  it('voting power = √(remaining credits)', async () => {
    expect(await strategy.getVotingPower(qvCtx(), 'GALICE')).toBe(10n); // √100
    const partSpent = qvCtx({ getSpentVoiceCredits: async () => 75 });
    expect(await strategy.getVotingPower(partSpent, 'GALICE')).toBe(5n); // √25
  });

  it('quorum counts voters, not weight', () => {
    const ctx = qvCtx({ currentLedger: 250, proposal: makeProposal({ quorum: '3' }) });
    const twoVoters = { for: 10n, against: 1n, abstain: 0n, totalVoters: 2 };
    expect(strategy.outcome(ctx, twoVoters)).toBe('defeated');
    const threeVoters = { for: 10n, against: 1n, abstain: 0n, totalVoters: 3 };
    expect(strategy.outcome(ctx, threeVoters)).toBe('succeeded');
  });
});

// ── Conviction strategy ─────────────────────────────────────────────────────

describe('conviction strategy', () => {
  const strategy = new ConvictionStrategy();

  it('decayFactor: 1 at Δ=0, exactly half at Δ=halfLife', () => {
    expect(decayFactor(0, 1000)).toBe(1_000_000_000n);
    expect(decayFactor(1000, 1000)).toBe(500_000_000n);
  });

  it('convictionNow follows the closed-form EMA (half-life semantics)', () => {
    // From 0 conviction with stake 1000: after one half-life, conviction = 500.
    const afterOneHalfLife = convictionNow({
      storedConviction: 0n,
      stake: 1_000n,
      lastUpdateLedger: 0,
      currentLedger: 1_000,
      halfLifeLedgers: 1_000,
    });
    expect(afterOneHalfLife).toBe(500n);

    // After two half-lives: 750. Compute in two lazy steps to prove
    // checkpointed recomputation matches the closed form.
    const afterTwo = convictionNow({
      storedConviction: afterOneHalfLife,
      stake: 1_000n,
      lastUpdateLedger: 1_000,
      currentLedger: 2_000,
      halfLifeLedgers: 1_000,
    });
    expect(afterTwo).toBe(750n);

    // Removing the stake decays conviction toward zero.
    const decaying = convictionNow({
      storedConviction: 800n,
      stake: 0n,
      lastUpdateLedger: 0,
      currentLedger: 1_000,
      halfLifeLedgers: 1_000,
    });
    expect(decaying).toBe(400n);
  });

  it('threshold scales with requested pool share and caps at supply', () => {
    const base = { totalSupply: 1_000_000n, maxRatioBps: 5_000 };
    const small = convictionThreshold({ ...base, requestedRatioBps: 500 });
    const large = convictionThreshold({ ...base, requestedRatioBps: 4_000 });
    expect(large > small).toBe(true);
    // At/over the max ratio the proposal is effectively unpassable.
    expect(convictionThreshold({ ...base, requestedRatioBps: 5_000 })).toBe(1_000_000n);
    // No ask defaults to 10% of supply.
    expect(convictionThreshold({ ...base, requestedRatioBps: 0 })).toBe(100_000n);
  });

  it('only accepts positive stakes in support, bounded by balance', async () => {
    const ctx = makeCtx({ config: makeConfig({ governanceType: 'conviction' }) });
    expect(
      (await strategy.validateVote(ctx, { voter: 'GALICE', support: 'against', amount: 10n }))
        .valid,
    ).toBe(false);
    expect(
      (await strategy.validateVote(ctx, { voter: 'GALICE', support: 'for', amount: 0n })).valid,
    ).toBe(false);
    expect(
      (await strategy.validateVote(ctx, { voter: 'GALICE', support: 'for', amount: 2_000n })).valid,
    ).toBe(false);
    const ok = await strategy.validateVote(ctx, { voter: 'GALICE', support: 'for', amount: 800n });
    expect(ok.valid).toBe(true);
    expect(ok.weight).toBe(800n);
  });

  it('tally recomputes lazy conviction per stake; outcome passes on threshold', async () => {
    const halfLife = 1_000;
    const ctx = makeCtx({
      currentLedger: 3_000,
      totalSupply: 10_000n,
      config: makeConfig({
        governanceType: 'conviction',
        convictionHalfLifeLedgers: halfLife,
        convictionMaxRatioBps: 5_000,
      }),
      proposal: makeProposal({ requestedRatioBps: 500, endBlock: 0 }),
    });
    // Stake 1000 committed since ledger 0 → ≈ 1000·(1−2^-3) = 875 conviction.
    const tally = await strategy.tally(ctx, [
      {
        voter: 'GALICE',
        support: 'for',
        stakeAmount: '1000',
        convictionAt: '0',
        lastUpdateLedger: 0,
      },
    ]);
    expect(tally.conviction).toBe(875n);
    // Threshold for 500/5000 bps of 10_000 supply: 10000·500/(4500·10000) → 0n… scaled: 111n
    const threshold = convictionThreshold({
      totalSupply: 10_000n,
      requestedRatioBps: 500,
      maxRatioBps: 5_000,
    });
    expect(strategy.outcome(ctx, tally)).toBe(
      tally.conviction! >= threshold ? 'succeeded' : 'pending',
    );
  });

  it('never defeats by time — stays pending below threshold', async () => {
    const ctx = makeCtx({
      currentLedger: 10,
      totalSupply: 1_000_000n,
      config: makeConfig({ governanceType: 'conviction', convictionMaxRatioBps: 5_000 }),
      proposal: makeProposal({ requestedRatioBps: 4_999, endBlock: 0 }),
    });
    const tally = await strategy.tally(ctx, [
      {
        voter: 'GALICE',
        support: 'for',
        stakeAmount: '10',
        convictionAt: '0',
        lastUpdateLedger: 10,
      },
    ]);
    expect(strategy.outcome(ctx, tally)).toBe('pending');
  });
});

// ── Multisig strategy ───────────────────────────────────────────────────────

describe('multisig strategy', () => {
  const strategy = new MultisigStrategy();
  const signers = ['GS1', 'GS2', 'GS3', 'GS4', 'GS5'];

  function msCtx(threshold = 3): StrategyContext {
    return makeCtx({
      config: makeConfig({ governanceType: 'multisig', multisigThreshold: threshold }),
      getActiveSigners: async () => signers,
    });
  }

  it('only active signers may confirm; each counts once', async () => {
    const notSigner = await strategy.validateVote(msCtx(), {
      voter: 'GOUTSIDER',
      support: 'confirm',
    });
    expect(notSigner.valid).toBe(false);

    const tally = await strategy.tally(msCtx(), [
      { voter: 'GS1', support: 'confirm' },
      { voter: 'GS1', support: 'confirm' }, // duplicate ignored
      { voter: 'GS2', support: 'for' }, // 'for' accepted as confirm
      { voter: 'GS3', support: 'against' },
    ]);
    expect(tally.for).toBe(2n);
    expect(tally.against).toBe(1n);
    expect(tally.totalVoters).toBe(3);
  });

  it('abstain is not a multisig option', async () => {
    const result = await strategy.validateVote(msCtx(), { voter: 'GS1', support: 'abstain' });
    expect(result.valid).toBe(false);
  });

  it('signer power is 1, non-signer power is 0', async () => {
    expect(await strategy.getVotingPower(msCtx(), 'GS1')).toBe(1n);
    expect(await strategy.getVotingPower(msCtx(), 'GOUTSIDER')).toBe(0n);
  });

  it('succeeds the moment the threshold is met', async () => {
    const tally = await strategy.tally(msCtx(3), [
      { voter: 'GS1', support: 'confirm' },
      { voter: 'GS2', support: 'confirm' },
      { voter: 'GS3', support: 'confirm' },
    ]);
    expect(strategy.outcome(msCtx(3), tally)).toBe('succeeded');
  });

  it('detects unreachable thresholds as defeated (with signer count)', async () => {
    // 3-of-5 with 3 rejections → only 2 possible confirms → defeated.
    const tally = await strategy.tally(msCtx(3), [
      { voter: 'GS1', support: 'against' },
      { voter: 'GS2', support: 'against' },
      { voter: 'GS3', support: 'against' },
    ]);
    expect(strategy.outcomeWithSignerCount(msCtx(3), tally, signers.length)).toBe('defeated');
    // 2 rejections → 3 confirms still possible → pending.
    const open = await strategy.tally(msCtx(3), [
      { voter: 'GS1', support: 'against' },
      { voter: 'GS2', support: 'against' },
    ]);
    expect(strategy.outcomeWithSignerCount(msCtx(3), open, signers.length)).toBe('pending');
  });
});

// ── Delegation resolver ─────────────────────────────────────────────────────

describe('delegation resolver', () => {
  const balances: Record<string, bigint> = {
    GA: 100n,
    GB: 200n,
    GC: 400n,
    GD: 800n,
  };
  const getOwnPower = async (wallet: string) => balances[wallet] ?? 0n;

  it('resolves a chain A -> B -> C so C votes with A+B+C power', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GB', category: 'all' },
      { delegator: 'GB', delegatee: 'GC', category: 'all' },
    ]);
    expect(await resolveVotingPower({ graph, wallet: 'GC', category: 'tech', getOwnPower })).toBe(
      700n, // 400 + 200 + 100
    );
    // B delegated away, so B's direct power excludes its own balance but
    // includes A's inbound delegation.
    expect(await resolveVotingPower({ graph, wallet: 'GB', category: 'tech', getOwnPower })).toBe(
      100n,
    );
  });

  it('is cycle-safe: A -> B -> A counts each wallet once', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GB', category: 'all' },
      { delegator: 'GB', delegatee: 'GA', category: 'all' },
    ]);
    // A delegated away (to B) so own power doesn't count directly, but the
    // inbound edge from B brings B's power; the cycle stops there.
    expect(await resolveVotingPower({ graph, wallet: 'GA', category: 'all', getOwnPower })).toBe(
      200n,
    );
    expect(await resolveVotingPower({ graph, wallet: 'GB', category: 'all', getOwnPower })).toBe(
      100n,
    );
  });

  it('truncates chains at MAX_DELEGATION_DEPTH (10)', async () => {
    // Chain W0 -> W1 -> ... -> W12, every wallet holds 1.
    const edges: DelegationEdge[] = [];
    for (let i = 0; i < 12; i++) {
      edges.push({ delegator: `W${i}`, delegatee: `W${i + 1}`, category: 'all' });
    }
    const graph = buildGraph(edges);
    const ones = async () => 1n;
    // W12's own 1 + inbound chain capped at depth 10 → 10 upstream wallets.
    expect(
      await resolveVotingPower({ graph, wallet: 'W12', category: 'all', getOwnPower: ones }),
    ).toBe(11n);
    expect(MAX_DELEGATION_DEPTH).toBe(10);
  });

  it('scopes per-category and treats "all" as wildcard', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GC', category: 'tech' },
      { delegator: 'GB', delegatee: 'GC', category: 'all' },
    ]);
    expect(await resolveVotingPower({ graph, wallet: 'GC', category: 'tech', getOwnPower })).toBe(
      700n, // own 400 + GA(tech) 100 + GB(all) 200
    );
    expect(
      await resolveVotingPower({ graph, wallet: 'GC', category: 'treasury', getOwnPower }),
    ).toBe(600n); // own 400 + GB(all) 200 — GA's tech edge doesn't apply
    expect(hasDelegatedAway(graph, 'GA', 'tech')).toBe(true);
    expect(hasDelegatedAway(graph, 'GA', 'treasury')).toBe(false);
  });

  it('ignores revoked edges (immediate revocation) and self-delegation', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GC', category: 'all', revokedAt: new Date() },
      { delegator: 'GC', delegatee: 'GC', category: 'all' },
      { delegator: 'GB', delegatee: 'GC', category: 'all' },
    ]);
    expect(await resolveVotingPower({ graph, wallet: 'GC', category: 'all', getOwnPower })).toBe(
      600n, // own 400 + GB 200; GA revoked, self-edge dropped
    );
    expect(hasDelegatedAway(graph, 'GC', 'all')).toBe(false);
  });

  it('subtracts a delegator who voted directly (override semantics)', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GB', category: 'all' },
      { delegator: 'GB', delegatee: 'GC', category: 'all' },
    ]);
    const resolved = await resolveVotingPower({
      graph,
      wallet: 'GC',
      category: 'all',
      getOwnPower,
    });
    expect(resolved).toBe(700n);
    // GB voted directly: GB's chain power (own 200 + GA 100) leaves GC's pool.
    const adjusted = await subtractOverrides({
      graph,
      delegatee: 'GC',
      category: 'all',
      resolvedPower: resolved,
      directVoters: new Set(['GB']),
      getOwnPower,
    });
    expect(adjusted).toBe(400n);
  });

  it('produces an analytics snapshot sorted by resolved power', async () => {
    const graph = buildGraph([
      { delegator: 'GA', delegatee: 'GD', category: 'all' },
      { delegator: 'GB', delegatee: 'GD', category: 'all' },
    ]);
    const snapshot = await graphSnapshot({ graph, category: 'all', getOwnPower });
    expect(snapshot.nodes[0].wallet).toBe('GD');
    expect(snapshot.nodes[0].resolvedPower).toBe('1100'); // 800 + 100 + 200
    expect(snapshot.nodes[0].delegators).toBe(2);
    expect(snapshot.edges).toHaveLength(2);
  });
});

// ── Integer-string helpers ──────────────────────────────────────────────────

describe('toBigInt', () => {
  it('parses integer strings, tolerates legacy decimals, falls back on junk', () => {
    expect(toBigInt('12345')).toBe(12_345n);
    expect(toBigInt('1500.75')).toBe(1_500n); // legacy Float rows
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined, 7n)).toBe(7n);
    expect(toBigInt('not-a-number')).toBe(0n);
  });
});
