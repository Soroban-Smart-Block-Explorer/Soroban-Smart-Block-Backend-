/**
 * Trace Engine — builds step-by-step execution traces from Soroban simulation.
 *
 * Converts raw DiagnosticEvents + simulation metadata into structured steps
 * that mirror Ethereum's debug_traceTransaction output.
 */
import { xdr, SorobanRpc, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { scValToJson } from './xdr-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TraceLevel = 'full' | 'calls_only' | 'state_changes_only';

export interface TraceArg {
  type: string;
  value: unknown;
}

export interface StateChange {
  key: string;
  before: unknown;
  after: unknown;
  changeType: 'write' | 'read' | 'delete';
}

export interface TraceStep {
  seq: number;
  depth: number;
  type: 'host_function' | 'event' | 'state_change';
  function: string;
  args: TraceArg[];
  gasUsed: number;
  memUsed: number;
  stateChanges: StateChange[];
  returnValue?: TraceArg;
  error?: string;
}

export interface CallGraphNode {
  id: string;
  contract: string;
  function: string;
  gas: number;
  depth: number;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  type: 'call' | 'return';
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

export interface TraceResult {
  steps: TraceStep[];
  totalGas: number;
  totalMemory: number;
  callGraph: CallGraph;
  events: unknown[];
  success: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodeContractId(raw: Buffer | Uint8Array): string {
  try {
    return StrKey.encodeContract(raw as Buffer);
  } catch {
    return Buffer.from(raw).toString('hex');
  }
}

function decodeScVal(val: xdr.ScVal): TraceArg {
  try {
    return scValToJson(val) as TraceArg;
  } catch {
    return { type: 'unknown', value: val.toXDR('base64') };
  }
}

function decodeTopics(topics: xdr.ScVal[]): TraceArg[] {
  return topics.map(decodeScVal);
}

/** Infer host function name from diagnostic event topic. */
function inferFunctionName(topic: string, topicArgs: TraceArg[]): string {
  if (topic === 'fn_call') {
    const name = topicArgs[0]?.value;
    return typeof name === 'string' ? name : 'call';
  }
  if (topic === 'fn_return') return 'return';
  return topic;
}

// ── Core builder ──────────────────────────────────────────────────────────────

/**
 * Build a full TraceResult from a successful or failed simulation response.
 */
export function buildTrace(
  diagnosticEvents: xdr.DiagnosticEvent[] | undefined,
  cost: SorobanRpc.Api.Cost | undefined,
  simEvents: SorobanRpc.Api.SimulateTransactionSuccessResponse['events'] | undefined,
  traceLevel: TraceLevel,
  success: boolean,
  errorMsg?: string,
): TraceResult {
  diagnosticEvents = diagnosticEvents ?? [];
  const totalCpu = Number(cost?.cpuInsns ?? 0);
  const totalMem = Number(cost?.memBytes ?? 0);
  const n = diagnosticEvents.length || 1;
  const cpuPerStep = Math.round(totalCpu / n);
  const memPerStep = Math.round(totalMem / n);

  const steps: TraceStep[] = [];
  const depthStack: string[] = [];
  const nodeMap = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];
  let nodeCounter = 0;
  let prevNodeId: string | null = null;

  for (let i = 0; i < diagnosticEvents.length; i++) {
    const de = diagnosticEvents[i];
    const ev = de.event();

    const contractRaw = ev.contractId();
    const contractId = contractRaw ? encodeContractId(contractRaw as unknown as Buffer) : 'system';

    const body = ev.body().value() as {
      topics: () => xdr.ScVal[];
      data: () => xdr.ScVal;
    };
    const rawTopics: xdr.ScVal[] = body?.topics?.() ?? [];
    const rawData: xdr.ScVal | undefined = body?.data?.();

    const topicArgs = decodeTopics(rawTopics);
    const [firstTopicArg, ...restArgs] = topicArgs;
    const topic = firstTopicArg
      ? typeof firstTopicArg.value === 'string'
        ? firstTopicArg.value
        : String(firstTopicArg.value)
      : ev.type().name;

    const fnName = inferFunctionName(topic, restArgs);
    const returnValue = topic === 'fn_return' && rawData ? decodeScVal(rawData) : undefined;
    const args = topic === 'fn_call' ? restArgs.slice(1) : restArgs;

    // Depth tracking
    let depth: number;
    if (topic === 'fn_call') {
      depth = depthStack.length;
      depthStack.push(`${contractId}:${fnName}`);
    } else if (topic === 'fn_return' && depthStack.length > 0) {
      depthStack.pop();
      depth = depthStack.length;
    } else {
      depth = depthStack.length;
    }

    // State changes from data field for storage-related topics
    const stateChanges: StateChange[] = [];
    if (['storage_put', 'storage_del', 'storage_get'].includes(topic) && rawData) {
      const decoded = decodeScVal(rawData);
      stateChanges.push({
        key: `${contractId}:${JSON.stringify(decoded.value)}`,
        before: null,
        after: topic === 'storage_del' ? null : decoded.value,
        changeType: topic === 'storage_del' ? 'delete' : topic === 'storage_get' ? 'read' : 'write',
      });
    }

    // Filter by traceLevel
    const isStateStep = stateChanges.length > 0;
    const isCallStep = topic === 'fn_call' || topic === 'fn_return';
    if (traceLevel === 'calls_only' && !isCallStep) continue;
    if (traceLevel === 'state_changes_only' && !isStateStep && !isCallStep) continue;

    const step: TraceStep = {
      seq: i,
      depth,
      type: isStateStep
        ? 'state_change'
        : topic === 'fn_call' || topic === 'fn_return'
          ? 'host_function'
          : 'event',
      function: fnName,
      args,
      gasUsed: cpuPerStep * (i + 1),
      memUsed: memPerStep * (i + 1),
      stateChanges,
      ...(returnValue ? { returnValue } : {}),
    };
    steps.push(step);

    // Build call graph nodes/edges
    if (topic === 'fn_call') {
      const nodeId = String(++nodeCounter);
      const node: CallGraphNode = {
        id: nodeId,
        contract: contractId,
        function: fnName,
        gas: cpuPerStep,
        depth,
      };
      nodeMap.set(`${contractId}:${fnName}:${depth}`, node);
      if (prevNodeId !== null) {
        edges.push({ from: prevNodeId, to: nodeId, type: 'call' });
      }
      prevNodeId = nodeId;
    }
  }

  return {
    steps,
    totalGas: totalCpu,
    totalMemory: totalMem,
    callGraph: {
      nodes: [...nodeMap.values()],
      edges,
    },
    events: simEvents ?? [],
    success,
    ...(errorMsg ? { error: errorMsg } : {}),
  };
}

/**
 * Extract DiagnosticEvents from a simulation response (success or error).
 */
export function extractDiagnosticEvents(
  result: SorobanRpc.Api.SimulateTransactionResponse,
): xdr.DiagnosticEvent[] {
  const raw = (result as any).events;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is xdr.DiagnosticEvent => e instanceof xdr.DiagnosticEvent);
}
