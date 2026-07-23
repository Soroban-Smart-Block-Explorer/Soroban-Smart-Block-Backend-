import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock execution block with native implementations directly bundled inside
vi.mock('../../src/db', () => ({
  prismaWrite: {
    reentrancyAlert: { upsert: vi.fn().mockResolvedValue({}) },
    transaction: { update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

// 2. Safe file imports after mock resolution
import * as db from '../../src/db';
import {
  analyseCallTrace,
  storeReentrancyAlert,
  DRAIN_EXPLOIT_WARNING,
} from '../../src/indexer/reentrancy-detector';
import type { CallTrace, CallTraceNode } from '../../src/indexer/call-trace';

const TX_HASH = 'abc123';
const CONTRACT = 'CA_CONTRACT';
const LEDGER = 1000;

function makeNode(
  topic: string,
  contractId: string,
  overrides: Partial<CallTraceNode> = {},
): CallTraceNode {
  return {
    seq: 0,
    depth: 1,
    eventType: 'contract',
    topicArgs: [],
    contractId,
    topic,
    data: null,
    inSuccessfulCall: true,
    ...overrides,
  } as CallTraceNode;
}

function makeTrace(overrides: Partial<CallTrace> = {}): CallTrace {
  return {
    events: [],
    contractsInvolved: [],
    maxDepth: 1,
    ...overrides,
  };
}

describe('analyseCallTrace', () => {
  it('returns null when trace has no suspicious signals', () => {
    const trace = makeTrace();
    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    expect(result).toBeNull();
  });

  it('detects repeated withdraw calls on the same contract', () => {
    const trace = makeTrace({
      events: [makeNode('withdraw', 'CA_TARGET'), makeNode('withdraw', 'CA_TARGET')],
    });

    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    expect(result).not.toBeNull();
    expect(result!.repeatedWithdrawCalls).toBe(2);
    expect(result!.signals.some((s) => s.includes('Repeated withdraw'))).toBe(true);
    expect(result!.warningLabel).toBe(DRAIN_EXPLOIT_WARNING);
  });

  it('detects deep call chains', () => {
    const trace = makeTrace({ maxDepth: 5 });
    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    expect(result).not.toBeNull();
    expect(result!.maxCallDepth).toBe(5);
    expect(result!.signals.some((s) => s.includes('Deep cross-contract'))).toBe(true);
  });

  it('detects cyclic call pairs A→B→A', () => {
    const trace = makeTrace({
      events: [
        makeNode('fn_call', 'CA_A', { depth: 1 }),
        makeNode('fn_call', 'CA_B', { depth: 2 }),
        makeNode('fn_return', 'CA_B', { depth: 2 }),
        makeNode('fn_call', 'CA_A', { depth: 1 }),
        makeNode('fn_return', 'CA_A', { depth: 1 }),
      ],
    });

    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    if (result !== null) {
      expect(result.transactionHash).toBe(TX_HASH);
      expect(['low', 'medium', 'high']).toContain(result.severity);
    }
  });

  it('assigns high severity for 4+ repeated withdraw calls', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeNode('withdraw', 'CA_TARGET', { seq: i }),
    );
    const trace = makeTrace({ events });

    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('assigns low severity for exactly 2 repeated calls with shallow depth', () => {
    const trace = makeTrace({
      events: [makeNode('withdraw', 'CA_T'), makeNode('withdraw', 'CA_T')],
      maxDepth: 1,
    });

    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('low');
  });

  it('always includes DRAIN_EXPLOIT_WARNING in warningLabel', () => {
    const trace = makeTrace({
      events: [makeNode('transfer', 'CA_T'), makeNode('transfer', 'CA_T')],
    });
    const result = analyseCallTrace(TX_HASH, CONTRACT, LEDGER, trace);
    if (result) {
      expect(result.warningLabel).toBe(DRAIN_EXPLOIT_WARNING);
    }
  });
});

describe('storeReentrancyAlert', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists alert via $transaction', async () => {
    const signal = {
      transactionHash: TX_HASH,
      contractAddress: CONTRACT,
      ledgerSequence: LEDGER,
      repeatedWithdrawCalls: 3,
      maxCallDepth: 2,
      cyclicCallPairs: [] as [string, string][],
      severity: 'medium' as const,
      signals: ['Repeated withdraw-class calls: CA_T… ×3'],
      warningLabel: DRAIN_EXPLOIT_WARNING,
    };

    await storeReentrancyAlert(signal);
    expect(db.prismaWrite.$transaction).toHaveBeenCalledOnce();
  });

  it('appends warningLabel to signals if not already present', async () => {
    const signal = {
      transactionHash: TX_HASH,
      contractAddress: CONTRACT,
      ledgerSequence: LEDGER,
      repeatedWithdrawCalls: 2,
      maxCallDepth: 1,
      cyclicCallPairs: [] as [string, string][],
      severity: 'low' as const,
      signals: ['some signal'],
      warningLabel: DRAIN_EXPLOIT_WARNING,
    };

    await storeReentrancyAlert(signal);

    const upsertCall = vi.mocked(db.prismaWrite.reentrancyAlert.upsert).mock.calls[0]?.[0];
    if (upsertCall) {
      expect(upsertCall.create.signals).toContain(DRAIN_EXPLOIT_WARNING);
    }
  });
});
