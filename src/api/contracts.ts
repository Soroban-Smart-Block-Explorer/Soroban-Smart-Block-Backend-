import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { abiRouter } from './abi';
import { archiveRouter } from './archive';
import { validateAddressParam, isValidStellarAddress } from '../middleware/sanitize';
import { contractAuditRouter } from './contract-audit';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Contracts
 *   description: Registered and indexed Soroban contracts, ABI metadata, and simulation
 */

export const contractRouter = Router();

contractRouter.use('/:address/abi', abiRouter);
contractRouter.use('/:address/state', archiveRouter);

const abiSchema = z.object({
  address: z
    .string()
    .refine(isValidStellarAddress, { message: 'Invalid Stellar contract address' }),
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
    orderBy: [{ _count: { functionName: 'desc' } }, { functionName: 'asc' }],
  });

  return stats.map((stat) => ({
    functionName: stat.functionName!,
    callCount: stat._count.functionName,
    lastCalledAt: stat._max.ledgerCloseTime,
  }));
}

/**
 * @swagger
 * /api/v1/contracts:
 *   get:
 *     summary: List all indexed contracts
 *     tags: [Contracts]
 *     responses:
 *       200:
 *         description: All contracts, newest first (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 description: Contract summary (subset of the full Contract record)
 *                 properties:
 *                   address: { type: string }
 *                   name: { type: string, nullable: true }
 *                   description: { type: string, nullable: true }
 *                   isToken: { type: boolean }
 *                   tokenSymbol: { type: string, nullable: true }
 *               example:
 *                 - address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                   name: USD Coin
 *                   description: USDC stablecoin token contract
 *                   isToken: true
 *                   tokenSymbol: USDC
 *                 - address: CSWAP5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                   name: StellarSwap Router
 *                   description: AMM router contract
 *                   isToken: false
 *                   tokenSymbol: null
 */
// GET /contracts
contractRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const contracts = await prismaRead.contract.findMany({
      select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(contracts);
  }),
);

/**
 * @swagger
 * /api/v1/contracts/{address}/stats:
 *   get:
 *     summary: Per-function call statistics for a contract
 *     tags: [Contracts]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Only count calls at or after this ISO-8601 timestamp
 *     responses:
 *       200:
 *         description: Function call counts, ordered by call count descending
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   functionName: { type: string }
 *                   callCount: { type: integer, description: 'Number of calls to this function' }
 *                   lastCalledAt:
 *                     type: string
 *                     format: date-time
 *                     nullable: true
 *                     description: Ledger close time of the most recent call
 *               example:
 *                 - functionName: swap
 *                   callCount: 1543
 *                   lastCalledAt: '2026-06-19T07:24:26.000Z'
 *                 - functionName: add_liquidity
 *                   callCount: 211
 *                   lastCalledAt: '2026-06-18T22:10:00.000Z'
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'since must be a valid ISO-8601 datetime' }
 *       404:
 *         description: Contract not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'Contract not found' }
 */
// GET /contracts/:address/stats
contractRouter.get(
  '/:address/stats',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { since } = contractStatsQuerySchema.parse(req.query);
    const stats = await getContractFunctionStats(
      req.params.address,
      since ? new Date(since) : undefined,
    );

    if (stats === null) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    return res.json(stats);
  }),
);

/**
 * @swagger
 * /api/v1/contracts/{address}:
 *   get:
 *     summary: Get a contract with its 10 most recent transactions and events
 *     tags: [Contracts]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address
 *     responses:
 *       200:
 *         description: The full contract record plus recent activity
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Contract'
 *                 - type: object
 *                   properties:
 *                     transactions:
 *                       type: array
 *                       description: Up to 10 most recent transactions (summary fields)
 *                       items:
 *                         type: object
 *                         properties:
 *                           hash: { type: string, example: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566' }
 *                           functionName: { type: string, nullable: true, example: transfer }
 *                           humanReadable: { type: string, nullable: true, example: 'GBZX...transferred 100 USDC' }
 *                           ledgerSequence: { type: integer, example: 3168075 }
 *                     events:
 *                       type: array
 *                       description: Up to 10 most recent events (summary fields)
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string, example: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg==' }
 *                           eventType: { type: string, example: transfer }
 *                           decoded: { type: object, nullable: true, example: { from: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI', amount: '1000000000' } }
 *                           ledgerSequence: { type: integer, example: 3168075 }
 *       404:
 *         description: Contract not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'Contract not found' }
 */
// GET /contracts/:address
contractRouter.get(
  '/:address',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const contract = await prismaRead.contract.findUnique({
      where: { address: req.params.address },
      include: {
        transactions: {
          take: 10,
          orderBy: { ledgerSequence: 'desc' },
          select: { hash: true, functionName: true, humanReadable: true, ledgerSequence: true },
        },
        events: {
          take: 10,
          orderBy: { ledgerSequence: 'desc' },
          select: { id: true, eventType: true, decoded: true, ledgerSequence: true },
        },
      },
    });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    res.json(contract);
  }),
);

/**
 * @swagger
 * /api/v1/contracts:
 *   post:
 *     summary: Register or update contract ABI metadata
 *     tags: [Contracts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address]
 *             properties:
 *               address: { type: string, description: 'Stellar contract address (validated)' }
 *               name: { type: string, maxLength: 256 }
 *               description: { type: string, maxLength: 2048 }
 *               abi: { type: object, description: 'ABI metadata (functions, events, types)' }
 *             example:
 *               address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *               name: USD Coin
 *               description: USDC stablecoin token contract
 *               abi: { functions: [{ name: transfer, inputs: [{ name: to, type: Address }, { name: amount, type: i128 }] }] }
 *     responses:
 *       201:
 *         description: The created or updated contract
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Contract' }
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'address is required' }
 */
// POST /contracts — register ABI metadata
contractRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const data = abiSchema.parse(req.body);
      const contract = await prismaWrite.contract.upsert({
        where: { address: data.address },
        update: { name: data.name, description: data.description, abi: data.abi as object },
        create: {
          address: data.address,
          name: data.name,
          description: data.description,
          abi: data.abi as object,
        },
      });
      res.status(201).json(contract);
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  }),
);

// ── Audit sub-router — /contracts/:address/audit/* ────────────────────────────
// Must be mounted before /:address/simulate/* to avoid route shadowing.
// The audit router uses mergeParams:true so req.params.address is available.
contractRouter.use('/:address/audit', contractAuditRouter);

// ── Contract Simulation Routes ────────────────────────────────────────────────

import { rpc as sorobanRpc } from '../indexer/rpc';
import { SorobanRpc, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { buildTrace, extractDiagnosticEvents } from '../indexer/trace-engine';
import { analyzeSimulationFailure } from '../indexer/revert-analyzer';
import { config } from '../config';

import { fetchContractSpec } from '../indexer/wasm-spec';

/**
 * GET /contracts/:address/simulate/functions
 * Lists functions that can be simulated for a registered contract.
 * Combines ABI metadata with on-chain contract spec (WASM).
 */
contractRouter.get(
  '/:address/simulate/functions',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    const [contract, wasmSpec] = await Promise.all([
      prismaRead.contract.findUnique({
        where: { address },
        select: { address: true, name: true, abi: true, isToken: true },
      }),
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
            inputs: Object.entries((d.properties as Record<string, unknown>) ?? {}).map(
              ([k, v]) => ({ name: k, type: (v as any)?.type ?? 'unknown' }),
            ),
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
  }),
);

/**
 * POST /contracts/:address/simulate/:functionName
 * Quick simulation of a specific function by providing args as JSON array.
 * Body: { args: [...ScVal JSON], txEnvelope?: "base64-xdr" }
 */
contractRouter.post(
  '/:address/simulate/:functionName',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address, functionName } = req.params;
    const { txEnvelope } = req.body as { txEnvelope?: string };

    if (!txEnvelope) {
      return res.status(400).json({
        error:
          'txEnvelope (base64 XDR) is required. Build a transaction calling the function and pass the XDR.',
        hint: `Simulate ${functionName} on ${address} by constructing a TransactionEnvelope XDR that invokes this function.`,
      });
    }

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
      rpcResult = await Promise.race([
        sorobanRpc.simulateTransaction(txObj),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
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

    return res.status(isSuccess ? 200 : 422).json({
      contract: address,
      function: functionName,
      status: isSuccess ? 'success' : 'failed',
      trace,
      revertAnalysis,
    });
  }),
);
