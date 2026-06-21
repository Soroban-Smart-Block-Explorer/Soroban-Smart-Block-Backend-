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
  address: ['scvAddress'],
  bool: ['scvBool'],
  i128: ['scvI128'],
  u128: ['scvU128'],
  i64: ['scvI64'],
  u64: ['scvU64'],
  i32: ['scvI32'],
  u32: ['scvU32'],
  string: ['scvString'],
  symbol: ['scvSymbol'],
  bytes: ['scvBytes'],
  void: ['scvVoid'],
};

function detectTypeMismatch(abiType: string, xdrType: string, value: unknown): string | null {
  const allowed = XDR_TYPE_MAP[abiType.toLowerCase()];
  if (!allowed) return null;
  if (!allowed.includes(xdrType))
    return `Type mismatch: expected ${abiType} (${allowed.join('|')}) but got ${xdrType}`;
  if (['u32', 'u64', 'u128'].includes(abiType) && typeof value === 'bigint' && value < 0n)
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
      issues.push({
        index: i,
        name: param.name,
        expectedType: param.type,
        providedType: 'missing',
        value: undefined,
        issue: `Missing required argument "${param.name}" (expected ${param.type})`,
      });
      continue;
    }
    const decoded = decodeScVal(val, param, decimals);
    const mismatch = detectTypeMismatch(param.type, val.switch().name, decoded.raw);
    if (mismatch)
      issues.push({
        index: i,
        name: param.name,
        expectedType: param.type,
        providedType: val.switch().name,
        value: decoded.formatted,
        issue: mismatch,
      });
  }
  if (rawArgs.length > fn.inputs.length)
    issues.push({
      index: fn.inputs.length,
      name: '(extra)',
      expectedType: 'none',
      providedType: 'extra',
      value: null,
      issue: `${rawArgs.length - fn.inputs.length} unexpected extra argument(s) passed to "${fnName}"`,
    });
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
simulateRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { transaction } = req.body as { transaction?: string };
    if (!transaction || typeof transaction !== 'string')
      return res.status(400).json({ error: 'Body must include a base64 XDR "transaction" field.' });

    const parsed = parseInvokeHostFunction(transaction);

    let txObj: Transaction | FeeBumpTransaction;
    try {
      try {
        txObj = new Transaction(transaction, config.networkPassphrase);
      } catch {
        txObj = new FeeBumpTransaction(transaction, config.networkPassphrase);
      }
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
    if (
      SorobanRpc.Api.isSimulationSuccess(rpcResult) ||
      SorobanRpc.Api.isSimulationRestore(rpcResult)
    ) {
      const footprint = formatFootprint(rpcResult);
      const authSnapshots = rpcResult.result?.auth
        ? generateAuthSnapshots(rpcResult.result.auth)
        : [];

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
      (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse)
        .events as xdr.DiagnosticEvent[],
    );

    let paramIssues: ParamDiagnostic[] = [];
    let humanSummary = rpcError;

    if (parsed) {
      const { contractId, functionName } = parsed;
      let rawArgs: xdr.ScVal[] = [];
      try {
        const envelope = xdr.TransactionEnvelope.fromXDR(transaction, 'base64');
        const ops =
          envelope.switch().name === 'envelopeTypeTx'
            ? envelope.v1().tx().operations()
            : envelope.v0().tx().operations();
        const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
        if (invokeOp)
          rawArgs = invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
      } catch {
        /* leave empty */
      }

      const [abi, contract] = await Promise.all([
        getContractAbi(contractId),
        prisma.contract.findUnique({ where: { address: contractId } }),
      ]);

      paramIssues = diagnoseArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);
      humanSummary =
        paramIssues.length > 0
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
  }),
);

import { buildTrace, extractDiagnosticEvents, TraceLevel } from '../indexer/trace-engine';
import { analyzeRevert, analyzeSimulationFailure } from '../indexer/revert-analyzer';
import { getTransaction } from '../indexer/rpc';
import { asyncHandler } from '../middleware/asyncHandler';

// ── POST /simulate/trace ──────────────────────────────────────────────────────

simulateRouter.post(
  '/trace',
  asyncHandler(async (req: Request, res: Response) => {
    const { txEnvelope, traceLevel = 'full' } = req.body as {
      txEnvelope?: string;
      traceLevel?: TraceLevel;
    };
    if (!txEnvelope || typeof txEnvelope !== 'string')
      return res.status(400).json({ error: 'Body must include a base64 XDR "txEnvelope" field.' });
    if (!['full', 'calls_only', 'state_changes_only'].includes(traceLevel))
      return res
        .status(400)
        .json({ error: 'traceLevel must be "full", "calls_only", or "state_changes_only".' });

    let txObj: Transaction | FeeBumpTransaction;
    try {
      try {
        txObj = new Transaction(txEnvelope, config.networkPassphrase);
      } catch {
        txObj = new FeeBumpTransaction(txEnvelope, config.networkPassphrase);
      }
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

    const diagnosticEvents = extractDiagnosticEvents(rpcResult);
    const isSuccess =
      SorobanRpc.Api.isSimulationSuccess(rpcResult) ||
      SorobanRpc.Api.isSimulationRestore(rpcResult);
    const cost = isSuccess
      ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).cost
      : undefined;
    const simEvents = isSuccess
      ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).events
      : undefined;
    const errorMsg = isSuccess
      ? undefined
      : (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;

    const trace = buildTrace(diagnosticEvents, cost, simEvents, traceLevel, isSuccess, errorMsg);

    if (!isSuccess) {
      const revertAnalysis = analyzeSimulationFailure(
        rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse,
        diagnosticEvents,
      );
      return res.status(422).json({ status: 'failed', trace, revertAnalysis });
    }

    return res.json({ status: 'success', trace });
  }),
);

// ── POST /simulate/compare ────────────────────────────────────────────────────

interface SimulateVariant {
  name: string;
  txEnvelope: string;
}

simulateRouter.post(
  '/compare',
  asyncHandler(async (req: Request, res: Response) => {
    const { base, variants } = req.body as {
      base?: { txEnvelope: string };
      variants?: SimulateVariant[];
    };
    if (!base?.txEnvelope) return res.status(400).json({ error: 'base.txEnvelope is required.' });
    if (!Array.isArray(variants) || variants.length === 0)
      return res.status(400).json({ error: 'variants array is required and must not be empty.' });

    async function runSim(envelope: string, name: string) {
      let txObj: Transaction | FeeBumpTransaction;
      try {
        try {
          txObj = new Transaction(envelope, config.networkPassphrase);
        } catch {
          txObj = new FeeBumpTransaction(envelope, config.networkPassphrase);
        }
      } catch (err) {
        return { name, error: `Invalid XDR: ${String(err)}` };
      }
      try {
        const result = await withTimeout(rpc.simulateTransaction(txObj), SIMULATION_TIMEOUT_MS);
        const isSuccess =
          SorobanRpc.Api.isSimulationSuccess(result) || SorobanRpc.Api.isSimulationRestore(result);
        const cost = isSuccess
          ? (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).cost
          : undefined;
        const diagnosticEvents = extractDiagnosticEvents(result);
        const simEvents = isSuccess
          ? (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).events
          : undefined;
        const errorMsg = isSuccess
          ? undefined
          : (result as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        const trace = buildTrace(diagnosticEvents, cost, simEvents, 'full', isSuccess, errorMsg);
        const revertAnalysis = isSuccess
          ? null
          : analyzeSimulationFailure(
              result as SorobanRpc.Api.SimulateTransactionErrorResponse,
              diagnosticEvents,
            );
        return { name, status: isSuccess ? 'success' : 'failed', trace, revertAnalysis };
      } catch (err) {
        return { name, error: String(err) };
      }
    }

    const [baseResult, ...variantResults] = await Promise.all([
      runSim(base.txEnvelope, 'base'),
      ...variants.map((v) => runSim(v.txEnvelope, v.name)),
    ]);

    return res.json({ base: baseResult, variants: variantResults });
  }),
);

// ── POST /simulate/replay/:txHash ─────────────────────────────────────────────

simulateRouter.post(
  '/replay/:txHash',
  asyncHandler(async (req: Request, res: Response) => {
    const { txHash } = req.params;
    if (!/^[0-9a-fA-F]{64}$/.test(txHash))
      return res.status(400).json({ error: 'txHash must be a 64-character hex string.' });

    // Fetch historical transaction
    let txRecord: Awaited<ReturnType<typeof getTransaction>>;
    try {
      txRecord = await withTimeout(getTransaction(txHash), SIMULATION_TIMEOUT_MS);
    } catch (err) {
      return res
        .status(502)
        .json({ error: 'Failed to fetch transaction from RPC', detail: String(err) });
    }

    if ((txRecord as any).status === 'NOT_FOUND')
      return res.status(404).json({ error: 'Transaction not found' });

    // Extract envelope XDR
    let envelopeXdr: string;
    try {
      envelopeXdr =
        (txRecord as any).envelopeXdr?.toXDR?.('base64') ?? (txRecord as any).envelopeXdr;
      if (!envelopeXdr) throw new Error('No envelope XDR in transaction record');
    } catch (err) {
      return res.status(422).json({ error: 'Could not extract envelope XDR', detail: String(err) });
    }

    // Replay: re-simulate using the original envelope
    let txObj: Transaction | FeeBumpTransaction;
    try {
      try {
        txObj = new Transaction(envelopeXdr, config.networkPassphrase);
      } catch {
        txObj = new FeeBumpTransaction(envelopeXdr, config.networkPassphrase);
      }
    } catch (err) {
      return res.status(422).json({ error: 'Could not parse envelope XDR', detail: String(err) });
    }

    let rpcResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      rpcResult = await withTimeout(rpc.simulateTransaction(txObj), SIMULATION_TIMEOUT_MS);
    } catch (err) {
      return res.status(502).json({ error: 'RPC simulation failed', detail: String(err) });
    }

    const diagnosticEvents = extractDiagnosticEvents(rpcResult);
    const isSuccess =
      SorobanRpc.Api.isSimulationSuccess(rpcResult) ||
      SorobanRpc.Api.isSimulationRestore(rpcResult);
    const cost = isSuccess
      ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).cost
      : undefined;
    const simEvents = isSuccess
      ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).events
      : undefined;
    const errorMsg = isSuccess
      ? undefined
      : (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;

    const trace = buildTrace(diagnosticEvents, cost, simEvents, 'full', isSuccess, errorMsg);
    const revertAnalysis = isSuccess
      ? null
      : analyzeSimulationFailure(
          rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse,
          diagnosticEvents,
        );

    return res.json({
      txHash,
      originalStatus: (txRecord as any).status,
      replayStatus: isSuccess ? 'success' : 'failed',
      trace,
      revertAnalysis,
      envelopeXdr,
    });
  }),
);
