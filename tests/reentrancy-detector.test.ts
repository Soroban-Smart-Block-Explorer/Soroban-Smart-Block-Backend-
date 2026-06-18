import { describe, it, expect } from 'vitest';
import { analyseCallTrace, DRAIN_EXPLOIT_WARNING } from '../src/indexer/reentrancy-detector';
import { type CallTrace, type CallTraceNode } from '../src/indexer/call-trace';

const TX = 'abc123';
const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const LEDGER = 1000;

function makeTrace(events: Partial<CallTraceNode>[]): CallTrace {
  const nodes: CallTraceNode[] = events.map((e, i) => ({
    seq: i,
    depth: e.depth ?? 0,
    contractId: e.contractId ?? CONTRACT,
    eventType: e.eventType ?? 'contract',
    topic: e.topic ?? 'transfer',
    topicArgs: e.topicArgs ?? [],
    data: e.data ?? null,
    inSuccessfulCall: e.inSuccessfulCall ?? true,
    cpuDelta: null,
    memDelta: null,
    label: e.label ?? '',
  }));
  const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
  const contractsInvolved = [...new Set(nodes.map((n) => n.contractId))].filter(
    (c) => c !== 'system',
  );
  return { events: nodes, contractsInvolved, maxDepth };
}

describe('analyseCallTrace', () => {
  it('returns null for a clean trace', () => {
    const trace = makeTrace([
      { topic: 'transfer', depth: 0 },
      { topic: 'fn_return', depth: 0 },
    ]);
    expect(analyseCallTrace(TX, CONTRACT, LEDGER, trace)).toBeNull();
  });

  it('flags repeated withdraw calls to the same contract', () => {
    const trace = makeTrace([
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal).not.toBeNull();
    expect(signal!.repeatedWithdrawCalls).toBe(3);
    expect(signal!.signals.some((s) => s.includes('withdraw'))).toBe(true);
  });

  it('flags deep call chains', () => {
    const trace = makeTrace([
      { topic: 'fn_call', depth: 0 },
      { topic: 'fn_call', depth: 1 },
      { topic: 'fn_call', depth: 2 },
      { topic: 'fn_call', depth: 3 },
      { topic: 'fn_call', depth: 4 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal).not.toBeNull();
    expect(signal!.maxCallDepth).toBe(4);
    expect(signal!.signals.some((s) => s.includes('depth'))).toBe(true);
  });

  it('detects cyclic call pairs (A→B→A)', () => {
    const A = CONTRACT;
    const B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const trace = makeTrace([
      { topic: 'fn_call', contractId: A, depth: 0 },
      { topic: 'fn_call', contractId: B, depth: 1 },
      { topic: 'fn_call', contractId: A, depth: 2 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal).not.toBeNull();
    expect(signal!.cyclicCallPairs.length).toBeGreaterThan(0);
    expect(signal!.signals.some((s) => s.includes('Cyclic'))).toBe(true);
  });

  it('assigns high severity for ≥4 repeated withdraw calls', () => {
    const trace = makeTrace([
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal!.severity).toBe('high');
  });

  it('assigns high severity for cyclic calls regardless of depth', () => {
    const A = CONTRACT;
    const B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const trace = makeTrace([
      { topic: 'fn_call', contractId: A, depth: 0 },
      { topic: 'fn_call', contractId: B, depth: 1 },
      { topic: 'fn_call', contractId: A, depth: 2 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal!.severity).toBe('high');
  });

  it('assigns low severity for a single depth-only trigger', () => {
    const trace = makeTrace([
      { topic: 'fn_call', depth: 0 },
      { topic: 'fn_call', depth: 1 },
      { topic: 'fn_call', depth: 2 },
      { topic: 'fn_call', depth: 3 },
      { topic: 'fn_call', depth: 4 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal!.severity).toBe('low');
  });

  it('attaches the canonical drain exploit warning label to every signal', () => {
    const trace = makeTrace([
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
      { topic: 'withdraw', contractId: CONTRACT, depth: 1 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal).not.toBeNull();
    expect(signal!.warningLabel).toBe(DRAIN_EXPLOIT_WARNING);
    expect(signal!.warningLabel).toBe('Potential Smart Contract Drain Exploit Pattern Detected');
  });

  it('warning label is present on cyclic call detection', () => {
    const A = CONTRACT;
    const B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const trace = makeTrace([
      { topic: 'fn_call', contractId: A, depth: 0 },
      { topic: 'fn_call', contractId: B, depth: 1 },
      { topic: 'fn_call', contractId: A, depth: 2 },
    ]);
    const signal = analyseCallTrace(TX, CONTRACT, LEDGER, trace);
    expect(signal!.warningLabel).toBe(DRAIN_EXPLOIT_WARNING);
  });
});
