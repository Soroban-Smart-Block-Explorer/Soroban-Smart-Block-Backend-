import { xdr, StrKey, scValToNative } from '@stellar/stellar-sdk';

export interface CallTraceNode {
  /** Chronological sequence index (0-based) */
  seq: number;
  /** Nesting depth — 0 = root call, 1 = first cross-contract call, etc. */
  depth: number;
  /** Contract that emitted this event */
  contractId: string;
  /** Event type: 'contract' | 'system' | 'diagnostic' */
  eventType: string;
  /** First topic symbol, e.g. "fn_call", "fn_return", "transfer" */
  topic: string;
  /** Decoded topic values beyond the first */
  topicArgs: unknown[];
  /** Decoded data payload */
  data: unknown;
  /** true = event fired inside a successful sub-call */
  inSuccessfulCall: boolean;
  /** CPU instructions consumed up to this point (cumulative from cost field) */
  cpuDelta: number | null;
  /** Memory bytes consumed up to this point */
  memDelta: number | null;
  /** Human-readable one-liner */
  label: string;
}

export interface CallTrace {
  /** Flat chronological list — use `depth` to reconstruct the tree */
  events: CallTraceNode[];
  /** Total unique contracts touched */
  contractsInvolved: string[];
  /** Deepest nesting level seen */
  maxDepth: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function contractIdFromHash(hash: Buffer): string {
  try {
    return StrKey.encodeContract(hash);
  } catch {
    return hash.toString('hex');
  }
}

function decodeTopics(topics: xdr.ScVal[]): string[] {
  return topics.map((t) => {
    try {
      return String(scValToNative(t));
    } catch {
      return t.toXDR('base64');
    }
  });
}

function decodeData(val: xdr.ScVal): unknown {
  try {
    return scValToNative(val);
  } catch {
    return val.toXDR('base64');
  }
}

/**
 * Soroban emits "fn_call" / "fn_return" diagnostic events to mark call
 * boundaries. We track depth by counting unmatched fn_call entries.
 */
function inferDepth(topic: string, depthStack: string[]): number {
  if (topic === 'fn_call') {
    const d = depthStack.length;
    depthStack.push('fn_call');
    return d;
  }
  if (topic === 'fn_return' && depthStack.length > 0) {
    depthStack.pop();
    return depthStack.length;
  }
  return depthStack.length;
}

function buildLabel(
  contractId: string,
  topic: string,
  topicArgs: unknown[],
  data: unknown,
): string {
  const short = contractId.slice(0, 8) + '…';
  if (topic === 'fn_call')
    return `→ [${short}] call ${topicArgs[0] ?? ''}(${topicArgs.slice(1).join(', ')})`;
  if (topic === 'fn_return') return `← [${short}] return ${JSON.stringify(data) ?? ''}`;
  if (topic === 'transfer')
    return `[${short}] transfer ${topicArgs.join(' → ')} amount=${JSON.stringify(data)}`;
  return `[${short}] ${topic}(${topicArgs.join(', ')})`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parse a DiagnosticEvent array (from simulateTransaction or ledger metadata)
 * into a chronological call trace with per-event resource deltas.
 *
 * @param diagnosticEvents  Raw XDR DiagnosticEvent array from the RPC response
 * @param totalCpuInsns     Total CPU instructions from sim cost (distributed evenly as a delta guide)
 * @param totalMemBytes     Total memory bytes from sim cost
 */
export function parseCallTrace(
  diagnosticEvents: xdr.DiagnosticEvent[],
  totalCpuInsns?: number,
  totalMemBytes?: number,
): CallTrace {
  const events: CallTraceNode[] = [];
  const contractsSet = new Set<string>();
  const depthStack: string[] = [];
  let maxDepth = 0;

  const n = diagnosticEvents.length;
  // Distribute resource totals evenly across events as approximate deltas
  const cpuPerEvent = n > 0 && totalCpuInsns != null ? Math.round(totalCpuInsns / n) : null;
  const memPerEvent = n > 0 && totalMemBytes != null ? Math.round(totalMemBytes / n) : null;

  for (let i = 0; i < n; i++) {
    const de = diagnosticEvents[i];
    const inSuccessfulCall = de.inSuccessfulContractCall();
    const ev = de.event();

    // Contract ID
    const contractIdOpt = ev.contractId();
    const contractId = contractIdOpt
      ? contractIdFromHash(contractIdOpt as unknown as Buffer)
      : 'system';
    contractsSet.add(contractId);

    // Event type
    const eventType = ev.type().name ?? 'unknown';

    // Topics + data
    const body = ev.body().value() as { topics: () => xdr.ScVal[]; data: () => xdr.ScVal };
    const rawTopics: xdr.ScVal[] = body?.topics?.() ?? [];
    const rawData: xdr.ScVal = body?.data?.();

    const [firstTopic, ...restTopics] = decodeTopics(rawTopics);
    const topic = firstTopic ?? eventType;
    const topicArgs = restTopics;
    const data = rawData ? decodeData(rawData) : null;

    // Depth tracking
    const depth = inferDepth(topic, depthStack);
    if (depth > maxDepth) maxDepth = depth;

    events.push({
      seq: i,
      depth,
      contractId,
      eventType,
      topic,
      topicArgs,
      data,
      inSuccessfulCall,
      cpuDelta: cpuPerEvent !== null ? cpuPerEvent * (i + 1) : null,
      memDelta: memPerEvent !== null ? memPerEvent * (i + 1) : null,
      label: buildLabel(contractId, topic, topicArgs, data),
    });
  }

  return {
    events,
    contractsInvolved: [...contractsSet].filter((c) => c !== 'system'),
    maxDepth,
  };
}
