import { Router, Request, Response } from 'express';
import { xdr, Transaction, FeeBumpTransaction, SorobanRpc } from '@stellar/stellar-sdk';
import { rpc } from '../indexer/rpc';
import { config } from '../config';
import { parseInvokeHostFunction } from '../indexer/xdr-parser';
import { getContractAbi } from '../indexer/registry';
import { decodeScVal } from '../indexer/args-decoder';
import { formatFootprint } from '../indexer/footprint-formatter';
import { generateAuthSnapshots } from '../indexer/auth-snippet-gen';
import { parseCallTrace } from '../indexer/call-trace';
import { classifyStorageEntries } from '../indexer/storage-classifier';
import { trackTtlChanges } from '../indexer/ttl-tracker';
import { prismaRead as prisma } from '../db';

export const simulateRouter = Router();

const SIMULATION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Simulation timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Param diagnostics ─────────────────────────────────────────────────────────

interface ParamDiagnostic {
  index: number;
  name: string;
  expectedType: string;
  providedType: string;
  value: unknown;
  issue: string;
}

const XDR_TYPE_MAP: Record<string, string[]> = {
  address: ['scvAddress'], bool: ['scvBool'],
  i128: ['scvI128'], u128: ['scvU128'], i64: ['scvI64'], u64: ['scvU64'],
  i32: ['scvI32'], u32: ['scvU32'], string: ['scvString'],
  symbol: ['scvSymbol'], bytes: ['scvBytes'], void: ['scvVoid'],
};

function detectTypeMismatch(abiType: string, xdrType: string, value: unknown): string | null {
  const allowed = XDR_TYPE_MAP[abiType.toLowerCase()];
  if (!allowed) return null;
  if (!allowed.includes(xdrType))
    return `Type mismatch: expected ${abiType} (${allowed.join('|')}) but got ${xdrType}`;
  if (['u32','u64','u128'].includes(abiType) && typeof value === 'bigint' && value < 0n)
    return `Value ${value} is negative but ${abiType} must be ≥ 0`;
  return null;
}

function diagnoseArgs(
  fnName: string,
  rawArgs: xdr.ScVal[],
  abi: Awaited<ReturnType<typeof getContractAbi>>,
  decimals?: number,
): ParamDiagnostic[] {
  if (!abi) return [];
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn) return [];
  const issues: ParamDiagnostic[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    const val = rawArgs[i];
    if (!val) {
      issues.push({ index: i, name: param.name, expectedType: param.type,
        providedType: 'missing', value: undefined,
        issue: `Missing required argument "${param.name}" (expected ${param.type})` });
      continue;
    }
    const decoded = decodeScVal(val, param, decimals);
    const mismatch = detectTypeMismatch(param.type, val.switch().name, decoded.raw);
    if (mismatch)
      issues.push({ index: i, name: param.name, expectedType: param.type,
        providedType: val.switch().name, value: decoded.formatted, issue: mismatch });
  }
  if (rawArgs.length > fn.inputs.length)
    issues.push({ index: fn.inputs.length, name: '(extra)', expectedType: 'none',
      providedType: 'extra', value: null,
      issue: `${rawArgs.length - fn.inputs.length} unexpected extra argument(s) passed to "${fnName}"` });
  return issues;
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/simulate
 * Body: { transaction: "<base64 XDR>" }
 *
 * Proxies to Soroban RPC simulateTransaction and overlays:
 *   - Resource footprint with % of protocol limits
 *   - Storage type classification (INSTANCE/PERSISTENT/TEMPORARY) — #55
 *   - TTL extension detection and rent payment tracking — #56
 *   - Chronological call-stack trace with per-event resource deltas
 *   - Recording-mode auth snapshots with JS/Rust signing snippets
 *   - On failure: ABI-aware per-param diagnostics
 */
simulateRouter.post('/', async (req: Request, res: Response) => {
  const { transaction } = req.body as { transaction?: string };
  if (!transaction || typeof transaction !== 'string')
    return res.status(400).json({ error: 'Body must include a base64 XDR "transaction" field.' });

  const parsed = parseInvokeHostFunction(transaction);

  let txObj: Transaction | FeeBumpTransaction;
  try {
    try { txObj = new Transaction(transaction, config.networkPassphrase); }
    catch { txObj = new FeeBumpTransaction(transaction, config.networkPassphrase); }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid transaction XDR', detail: String(err) });
  }

  let rpcResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    rpcResult = await withTimeout(rpc.simulateTransaction(txObj), SIMULATION_TIMEOUT_MS);
  } catch (err) {
    const isTimeout = String(err).includes('timed out');
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'Simulation timed out' : 'RPC request failed',
      detail: String(err),
    });
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (SorobanRpc.Api.isSimulationSuccess(rpcResult) || SorobanRpc.Api.isSimulationRestore(rpcResult)) {
    const footprint = formatFootprint(rpcResult);
    const authSnapshots = rpcResult.result?.auth
      ? generateAuthSnapshots(rpcResult.result.auth) : [];

    const cpuInsns = Number((rpcResult.cost as SorobanRpc.Api.Cost)?.cpuInsns ?? 0);
    const memBytes = Number((rpcResult.cost as SorobanRpc.Api.Cost)?.memBytes ?? 0);
    const callTrace = parseCallTrace(
      rpcResult.events as xdr.DiagnosticEvent[],
      cpuInsns || undefined,
      memBytes || undefined,
    );

    // #55 — Storage type classification
    const storageClassification = classifyStorageEntries(rpcResult);

    // #56 — TTL extension tracking
    const ttlTracking = trackTtlChanges(transaction, null, rpcResult.minResourceFee);

    return res.json({
      status: 'success',
      simulation: rpcResult,
      footprint,
      storageClassification,
      ttlTracking,
      callTrace,
      authSnapshots,
      parsed,
    });
  }

  // ── Failure — diagnostic overlay ──────────────────────────────────────────
  const rpcError = (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
  const callTrace = parseCallTrace(
    (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).events as xdr.DiagnosticEvent[],
  );

  let paramIssues: ParamDiagnostic[] = [];
  let humanSummary = rpcError;

  if (parsed) {
    const { contractId, functionName } = parsed;
    let rawArgs: xdr.ScVal[] = [];
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(transaction, 'base64');
      const ops = envelope.switch().name === 'envelopeTypeTx'
        ? envelope.v1().tx().operations() : envelope.v0().tx().operations();
      const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
      if (invokeOp)
        rawArgs = invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    } catch { /* leave empty */ }

    const [abi, contract] = await Promise.all([
      getContractAbi(contractId),
      prisma.contract.findUnique({ where: { address: contractId } }),
    ]);

    paramIssues = diagnoseArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);
    humanSummary = paramIssues.length > 0
      ? `Call to "${functionName}" on ${contract?.name ?? contractId} will fail:\n` +
        paramIssues.map((p) => `  • [arg ${p.index}] ${p.name}: ${p.issue}`).join('\n')
      : abi
        ? `Simulation failed for "${functionName}" on ${contract?.name ?? contractId}. ` +
          `Arguments look structurally valid — likely a contract assertion or missing auth. RPC: ${rpcError}`
        : rpcError;
  }

  return res.status(422).json({
    status: 'failed',
    callTrace,
    diagnostics: {
      rpcError,
      contract: parsed?.contractId ?? null,
      function: parsed?.functionName ?? null,
      paramIssues,
      humanSummary,
    },
  });
});
