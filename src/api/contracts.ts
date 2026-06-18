import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { fetchContractSpec } from '../indexer/wasm-spec';
import { abiRouter } from './abi';
import { validateAddressParam, isValidStellarAddress } from '../middleware/sanitize';

export const contractRouter = Router();

const abiSchema = z.object({
  address: z.string().refine(isValidStellarAddress, { message: 'Invalid Stellar contract address' }),
  name: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  abi: z.record(z.unknown()).optional(),
});

const contractStatsQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

export async function getContractFunctionStats(address: string, since?: Date) {
  const contract = await prismaRead.contract.findUnique({
    where: { address },
    select: { address: true },
  });

  if (!contract) {
    return null;
  }

  const stats = await prismaRead.transaction.groupBy({
    by: ['functionName'],
    where: {
      contractAddress: address,
      functionName: { not: null },
      ...(since ? { ledgerCloseTime: { gte: since } } : {}),
    },
    _count: {
      functionName: true,
    },
    _max: {
      ledgerCloseTime: true,
    },
    orderBy: [
      { _count: { functionName: 'desc' } },
      { functionName: 'asc' },
    ],
  });

  return stats.map((stat) => ({
    functionName: stat.functionName!,
    callCount: stat._count.functionName,
    lastCalledAt: stat._max.ledgerCloseTime,
  }));
}

// GET /contracts
contractRouter.get('/', async (_req: Request, res: Response) => {
  const contracts = await prismaRead.contract.findMany({
    select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(contracts);
});

// GET /contracts/:address/stats
contractRouter.get('/:address/stats', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const { since } = contractStatsQuerySchema.parse(req.query);
    const stats = await getContractFunctionStats(
      req.params.address,
      since ? new Date(since) : undefined,
    );

    if (stats === null) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    return res.json(stats);
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

// GET /contracts/:address
contractRouter.get('/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  const contract = await prismaRead.contract.findUnique({
    where: { address: req.params.address },
    include: {
      transactions: { take: 10, orderBy: { ledgerSequence: 'desc' }, select: { hash: true, functionName: true, humanReadable: true, ledgerSequence: true } },
      events: { take: 10, orderBy: { ledgerSequence: 'desc' }, select: { id: true, eventType: true, decoded: true, ledgerSequence: true } },
    },
  });
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  res.json(contract);
});

// POST /contracts — register ABI metadata
contractRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = abiSchema.parse(req.body);
    const contract = await prismaWrite.contract.upsert({
      where: { address: data.address },
      update: { name: data.name, description: data.description, abi: data.abi as object },
      create: { address: data.address, name: data.name, description: data.description, abi: data.abi as object },
    });
    res.status(201).json(contract);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── Contract Simulation Routes ────────────────────────────────────────────────

import { rpc as sorobanRpc } from '../indexer/rpc';
import { SorobanRpc, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { buildTrace, extractDiagnosticEvents } from '../indexer/trace-engine';
import { analyzeSimulationFailure } from '../indexer/revert-analyzer';
import { config } from '../config';

/**
 * GET /contracts/:address/simulate/functions
 * Lists functions that can be simulated for a registered contract.
 * Combines ABI metadata with on-chain contract spec (WASM).
 */
contractRouter.get('/:address/simulate/functions', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address } = req.params;

  const [contract, wasmSpec] = await Promise.all([
    prismaRead.contract.findUnique({ where: { address }, select: { address: true, name: true, abi: true, isToken: true } }),
    fetchContractSpec(address).catch(() => null),
  ]);

  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  // Merge ABI functions with WASM spec
  const abiFunctions: Array<{ name: string; inputs: unknown[]; simulatable: boolean }> = [];

  const abi = contract.abi as { functions?: Array<{ name: string; inputs: unknown[] }> } | null;
  if (abi?.functions) {
    for (const fn of abi.functions) {
      abiFunctions.push({ name: fn.name, inputs: fn.inputs ?? [], simulatable: true });
    }
  }

  if (wasmSpec && typeof wasmSpec === 'object') {
    const schema = wasmSpec as Record<string, unknown>;
    const definitions = (schema.definitions ?? schema.$defs ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(definitions)) {
      if (abiFunctions.find((f) => f.name === name)) continue; // already in ABI
      const d = def as Record<string, unknown>;
      if (d.type === 'object' || d.properties) {
        abiFunctions.push({
          name,
          inputs: Object.entries((d.properties as Record<string, unknown>) ?? {}).map(([k, v]) => ({ name: k, type: (v as any)?.type ?? 'unknown' })),
          simulatable: true,
        });
      }
    }
  }

  return res.json({
    address,
    name: contract.name ?? null,
    isToken: contract.isToken,
    functions: abiFunctions,
    wasmSpecAvailable: wasmSpec !== null,
  });
});

/**
 * POST /contracts/:address/simulate/:functionName
 * Quick simulation of a specific function by providing args as JSON array.
 * Body: { args: [...ScVal JSON], txEnvelope?: "base64-xdr" }
 */
contractRouter.post('/:address/simulate/:functionName', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address, functionName } = req.params;
  const { txEnvelope } = req.body as { txEnvelope?: string };

  if (!txEnvelope) {
    return res.status(400).json({
      error: 'txEnvelope (base64 XDR) is required. Build a transaction calling the function and pass the XDR.',
      hint: `Simulate ${functionName} on ${address} by constructing a TransactionEnvelope XDR that invokes this function.`,
    });
  }

  let txObj: Transaction | FeeBumpTransaction;
  try {
    try { txObj = new Transaction(txEnvelope, config.networkPassphrase); }
    catch { txObj = new FeeBumpTransaction(txEnvelope, config.networkPassphrase); }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid transaction XDR', detail: String(err) });
  }

  let rpcResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    rpcResult = await Promise.race([
      sorobanRpc.simulateTransaction(txObj),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);
  } catch (err) {
    return res.status(502).json({ error: 'RPC simulation failed', detail: String(err) });
  }

  const diagnosticEvents = extractDiagnosticEvents(rpcResult);
  const isSuccess = SorobanRpc.Api.isSimulationSuccess(rpcResult) || SorobanRpc.Api.isSimulationRestore(rpcResult);
  const cost = isSuccess ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).cost : undefined;
  const simEvents = isSuccess ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).events : undefined;
  const errorMsg = isSuccess ? undefined : (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;

  const trace = buildTrace(diagnosticEvents, cost, simEvents, 'full', isSuccess, errorMsg);
  const revertAnalysis = isSuccess
    ? null
    : analyzeSimulationFailure(rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse, diagnosticEvents);

  return res.status(isSuccess ? 200 : 422).json({
    contract: address,
    function: functionName,
    status: isSuccess ? 'success' : 'failed',
    trace,
    revertAnalysis,
  });
});
