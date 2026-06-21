import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { fetchContractSpec } from '../indexer/wasm-spec';
import { abiRouter } from './abi';
import { validateAddressParam, isValidStellarAddress } from '../middleware/sanitize';

/**
 * @swagger
 * tags:
 *   name: Contracts
 *   description: Registered and indexed Soroban contracts, ABI metadata, and simulation
 */

export const contractRouter = Router();

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
  async (req: Request, res: Response) => {
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
  },
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
contractRouter.post('/', async (req: Request, res: Response) => {
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
});

// ── Contract Simulation Routes ────────────────────────────────────────────────

import { rpc as sorobanRpc } from '../indexer/rpc';
import { SorobanRpc, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { buildTrace, extractDiagnosticEvents } from '../indexer/trace-engine';
import { analyzeSimulationFailure } from '../indexer/revert-analyzer';
import { config } from '../config';

import { analyzeWasmContract, decompileWasm } from '../indexer/wasm-decompiler';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * /api/v1/contracts/{address}/simulate/functions:
 *   get:
 *     summary: List simulatable functions for a contract
 *     description: Combines registered ABI metadata with the on-chain contract spec (WASM).
 *     tags: [Contracts]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address
 *     responses:
 *       200:
 *         description: Merged list of callable functions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                 name: { type: string, nullable: true, example: 'USD Coin' }
 *                 isToken: { type: boolean, example: true }
 *                 functions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string, example: transfer }
 *                       inputs:
 *                         type: array
 *                         items: { type: object }
 *                         description: Function input descriptors
 *                         example: [{ name: to, type: Address }, { name: amount, type: i128 }]
 *                       simulatable: { type: boolean, example: true }
 *                 wasmSpecAvailable: { type: boolean, description: 'Whether an on-chain WASM spec was found', example: true }
 *       404:
 *         description: Contract not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example: { error: 'Contract not found' }
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

// ── Contract Source / Decompilation Endpoints ───────────────────────────────

// Helper: fetch on-chain Wasm bytes for a contract address
async function fetchOnChainWasm(contractAddress: string): Promise<Buffer> {
  try {
    return await sorobanRpc.getContractWasmByContractId(contractAddress);
  } catch (err) {
    throw new Error('Failed to fetch on-chain Wasm for contract');
  }
}

// GET /contracts/:address/source — full source/decompiled view (on-chain)
contractRouter.get(
  '/:address/source',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      // Persist analysis to DB (upsert ContractSource)
      try {
        const cs = await (prismaWrite as any).contractSource.upsert({
          where: { contractAddress: address },
          create: {
            contractAddress: address,
            sourceType: analysis.sourceType,
            language: analysis.language,
            compilerVersion: analysis.compilerVersion ?? undefined,
            wasmHash: analysis.wasmHash,
            bytecodeSize: analysis.bytecodeSize,
            functions: analysis.functions as any,
            imports: analysis.imports as any,
            exports: analysis.exports as any,
            storageVariables: analysis.storageVariables as any,
            events: analysis.events as any,
            errors: analysis.errors as any,
            metadata: analysis.metadata as any,
            decompiledAt: new Date(analysis.decompiledAt),
            verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
          },
          update: {
            language: analysis.language,
            compilerVersion: analysis.compilerVersion ?? undefined,
            wasmHash: analysis.wasmHash,
            bytecodeSize: analysis.bytecodeSize,
            functions: analysis.functions as any,
            imports: analysis.imports as any,
            exports: analysis.exports as any,
            storageVariables: analysis.storageVariables as any,
            events: analysis.events as any,
            errors: analysis.errors as any,
            metadata: analysis.metadata as any,
            verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
          },
        });

        // Upsert function details
        for (const fn of analysis.functions) {
          await (prismaWrite as any).functionDetail.upsert({
            where: { contractId_name: { contractId: cs.id, name: fn.name } },
            create: {
              contractId: cs.id,
              name: fn.name,
              selector: fn.selector ?? undefined,
              visibility: 'public',
              params: fn.params as any,
              returns: fn.returns as any,
              pseudoCode: fn.pseudoCode ?? undefined,
              cfg: fn.cfg as any,
              complexity: fn.complexity ?? undefined,
              linesOfCode: fn.linesOfCode ?? 0,
              cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
              calls: fn.calls as any,
              storageOperations: fn.storageOperations as any,
              hostCalls: fn.hostCalls as any,
              sourceMap: fn.sourceMap as any,
            },
            update: {
              pseudoCode: fn.pseudoCode ?? undefined,
              cfg: fn.cfg as any,
              complexity: fn.complexity ?? undefined,
              linesOfCode: fn.linesOfCode ?? 0,
              cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
              calls: fn.calls as any,
              storageOperations: fn.storageOperations as any,
              hostCalls: fn.hostCalls as any,
              sourceMap: fn.sourceMap as any,
            },
          });
        }
      } catch (dbErr) {
        // Non-fatal: log and continue returning analysis
        // eslint-disable-next-line no-console
        console.warn('Failed to persist contract analysis', String(dbErr));
      }

      return res.json(analysis);
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
    }
  }),
);

// POST /contracts/source/decompile — accept raw Wasm (multipart field 'wasm' or JSON body { wasmBase64 })
contractRouter.post('/source/decompile', async (req: Request, res: Response) => {
  // support JSON body with base64 wasm
  try {
    if (req.body && typeof req.body.wasmBase64 === 'string') {
      const buf = Buffer.from(req.body.wasmBase64, 'base64');
      const analysis = analyzeWasmContract(buf);

      // Persist if contractAddress supplied
      const maybeAddress =
        typeof req.body.contractAddress === 'string' ? req.body.contractAddress : null;
      if (maybeAddress) {
        try {
          const cs = await (prismaWrite as any).contractSource.upsert({
            where: { contractAddress: maybeAddress },
            create: {
              contractAddress: maybeAddress,
              sourceType: analysis.sourceType,
              language: analysis.language,
              compilerVersion: analysis.compilerVersion ?? undefined,
              wasmHash: analysis.wasmHash,
              bytecodeSize: analysis.bytecodeSize,
              functions: analysis.functions as any,
              imports: analysis.imports as any,
              exports: analysis.exports as any,
              storageVariables: analysis.storageVariables as any,
              events: analysis.events as any,
              errors: analysis.errors as any,
              metadata: analysis.metadata as any,
              decompiledAt: new Date(analysis.decompiledAt),
              verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
            },
            update: {
              language: analysis.language,
              compilerVersion: analysis.compilerVersion ?? undefined,
              wasmHash: analysis.wasmHash,
              bytecodeSize: analysis.bytecodeSize,
              functions: analysis.functions as any,
              imports: analysis.imports as any,
              exports: analysis.exports as any,
              storageVariables: analysis.storageVariables as any,
              events: analysis.events as any,
              errors: analysis.errors as any,
              metadata: analysis.metadata as any,
              verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
            },
          });

          for (const fn of analysis.functions) {
            await (prismaWrite as any).functionDetail.upsert({
              where: { contractId_name: { contractId: cs.id, name: fn.name } },
              create: {
                contractId: cs.id,
                name: fn.name,
                selector: fn.selector ?? undefined,
                visibility: 'public',
                params: fn.params as any,
                returns: fn.returns as any,
                pseudoCode: fn.pseudoCode ?? undefined,
                cfg: fn.cfg as any,
                complexity: fn.complexity ?? undefined,
                linesOfCode: fn.linesOfCode ?? 0,
                cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
                calls: fn.calls as any,
                storageOperations: fn.storageOperations as any,
                hostCalls: fn.hostCalls as any,
                sourceMap: fn.sourceMap as any,
              },
              update: {
                pseudoCode: fn.pseudoCode ?? undefined,
                cfg: fn.cfg as any,
                complexity: fn.complexity ?? undefined,
                linesOfCode: fn.linesOfCode ?? 0,
                cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
                calls: fn.calls as any,
                storageOperations: fn.storageOperations as any,
                hostCalls: fn.hostCalls as any,
                sourceMap: fn.sourceMap as any,
              },
            });
          }
        } catch (dbErr) {
          // eslint-disable-next-line no-console
          console.warn('Failed to persist uploaded contract analysis', String(dbErr));
        }
      }

      return res.json(analysis);
    }
    return res.status(400).json({ error: 'Provide wasmBase64 in request body' });
  } catch (err: any) {
    return res.status(422).json({ error: 'Failed to decompile Wasm', detail: String(err) });
  }
});

// GET /contracts/:address/source/functions — list functions with signatures and complexity
contractRouter.get(
  '/:address/source/functions',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);
      const list = analysis.functions.map((f) => ({
        name: f.name,
        selector: f.selector,
        params: f.params,
        returns: f.returns,
        complexity: f.complexity,
        linesOfCode: f.linesOfCode,
      }));
      return res.json({ address, functions: list });
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/functions/:functionName — single function detail
contractRouter.get(
  '/:address/source/functions/:functionName',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address, functionName } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions.find(
        (f) => f.name === functionName || f.exportName === functionName,
      );
      if (!fn) return res.status(404).json({ error: 'Function not found' });
      return res.json(fn);
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/functions/:functionName/cfg — control flow graph for function
contractRouter.get(
  '/:address/source/functions/:functionName/cfg',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address, functionName } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);
      const fn = analysis.functions.find(
        (f) => f.name === functionName || f.exportName === functionName,
      );
      if (!fn) return res.status(404).json({ error: 'Function not found' });
      return res.json({ cfg: fn.cfg });
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
    }
  }),
);

// Exports / Imports / Events / Errors / Storage endpoints
contractRouter.get(
  '/:address/source/exports',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wasm = await fetchOnChainWasm(req.params.address);
      const analysis = analyzeWasmContract(wasm);
      return res.json(analysis.exports);
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not retrieve exports', detail: String(err) });
    }
  },
);

contractRouter.get(
  '/:address/source/imports',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wasm = await fetchOnChainWasm(req.params.address);
      const analysis = analyzeWasmContract(wasm);
      return res.json(analysis.imports);
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not retrieve imports', detail: String(err) });
    }
  },
);

contractRouter.get(
  '/:address/source/events',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wasm = await fetchOnChainWasm(req.params.address);
      const analysis = analyzeWasmContract(wasm);
      return res.json(analysis.events ?? []);
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not retrieve events', detail: String(err) });
    }
  },
);

contractRouter.get(
  '/:address/source/errors',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wasm = await fetchOnChainWasm(req.params.address);
      const analysis = analyzeWasmContract(wasm);
      return res.json(analysis.errors ?? []);
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not retrieve errors', detail: String(err) });
    }
  },
);

contractRouter.get(
  '/:address/source/storage',
  validateAddressParam('address'),
  async (req: Request, res: Response) => {
    try {
      const wasm = await fetchOnChainWasm(req.params.address);
      const analysis = analyzeWasmContract(wasm);
      return res.json(analysis.storageVariables ?? []);
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve storage layout', detail: String(err) });
    }
  },
);

/**
 * @swagger
 * /api/v1/contracts/{address}/simulate/{functionName}:
 *   post:
 *     summary: Simulate a contract function call
 *     description: >-
 *       Simulates a function invocation against the Soroban RPC using a provided
 *       transaction envelope, returning an execution trace and (on failure) a
 *       revert analysis.
 *     tags: [Contracts]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Contract address
 *       - in: path
 *         name: functionName
 *         required: true
 *         schema: { type: string }
 *         description: Name of the function to simulate
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txEnvelope]
 *             properties:
 *               txEnvelope:
 *                 type: string
 *                 description: Base64-encoded TransactionEnvelope XDR invoking the function (required)
 *               args:
 *                 type: array
 *                 items: { type: object }
 *                 description: Optional ScVal JSON arguments (informational; the envelope is authoritative)
 *             example:
 *               txEnvelope: AAAAAgAAAAAjbb31xRk1h0AAAGQAA8AAAAAAAAAAAAAAAE=
 *               args: []
 *     responses:
 *       200:
 *         description: Simulation succeeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contract: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                 function: { type: string, example: swap }
 *                 status: { type: string, enum: [success, failed], example: success }
 *                 trace: { $ref: '#/components/schemas/SimulationTrace' }
 *                 revertAnalysis: { type: object, nullable: true, description: 'Always null on success', example: null }
 *       422:
 *         description: Simulation executed but the function reverted/failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contract: { type: string, example: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 }
 *                 function: { type: string, example: swap }
 *                 status: { type: string, enum: [success, failed], example: failed }
 *                 trace: { $ref: '#/components/schemas/SimulationTrace' }
 *                 revertAnalysis: { $ref: '#/components/schemas/RevertAnalysis' }
 *               example:
 *                 contract: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                 function: swap
 *                 status: failed
 *                 trace:
 *                   steps: []
 *                   totalGas: 0
 *                   totalMemory: 0
 *                   callGraph: { nodes: [], edges: [] }
 *                   events: []
 *                   success: false
 *                   error: 'HostError: Error(Contract, #3)'
 *                 revertAnalysis:
 *                   errorType: contract_error
 *                   message: 'Contract call failed: insufficient balance'
 *                   detail: 'Error(Contract, #3)'
 *                   callStack:
 *                     - { depth: 0, contractId: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5, function: swap }
 *                   suggestedFixes:
 *                     - 'Ensure the account has sufficient balance before calling swap.'
 *       400:
 *         description: Missing txEnvelope or invalid transaction XDR
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string, example: 'txEnvelope (base64 XDR) is required.' }
 *                 hint: { type: string, description: 'Present when txEnvelope is missing', example: 'Simulate swap on CALLD... by constructing a TransactionEnvelope XDR.' }
 *                 detail: { type: string, description: 'Present when the XDR is invalid', example: 'Invalid transaction XDR' }
 *               example:
 *                 error: txEnvelope (base64 XDR) is required. Build a transaction calling the function and pass the XDR.
 *                 hint: Simulate swap on CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5 by constructing a TransactionEnvelope XDR that invokes this function.
 *       502:
 *         description: RPC simulation failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string, example: 'RPC simulation failed' }
 *                 detail: { type: string, example: 'timeout' }
 *               example:
 *                 error: RPC simulation failed
 *                 detail: timeout
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

// ── Template Registry & Similarity Endpoints ────────────────────────────────

// Known contract templates
const KNOWN_TEMPLATES = [
  {
    name: 'soroban_token',
    description: 'SEP-41 Token Standard',
    functions: ['transfer', 'balance', 'mint', 'burn'],
  },
  {
    name: 'soroban_pair',
    description: 'AMM Pair (StellarSwap)',
    functions: ['swap', 'deposit', 'withdraw', 'get_reserves'],
  },
  {
    name: 'soroban_nft',
    description: 'Soroban NFT',
    functions: ['mint', 'burn', 'transfer', 'balance_of'],
  },
  {
    name: 'soroban_lending',
    description: 'Lending Protocol',
    functions: ['deposit', 'borrow', 'repay', 'liquidate'],
  },
  {
    name: 'soroban_staking',
    description: 'Staking Contract',
    functions: ['stake', 'unstake', 'claim_rewards', 'get_stake'],
  },
];

// GET /templates — list known contract templates
contractRouter.get(
  '/templates',
  asyncHandler(async (_req: Request, res: Response) => {
    return res.json(KNOWN_TEMPLATES);
  }),
);

// GET /contracts/:address/source/similarity — compare against known templates
contractRouter.get(
  '/:address/source/similarity',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      // Calculate similarity to each template based on function signature overlap
      const similarities = KNOWN_TEMPLATES.map((template) => {
        const contractFuncNames = new Set(analysis.functions.map((f) => f.name.toLowerCase()));
        const templateFuncNames = new Set(template.functions.map((f) => f.toLowerCase()));

        const matches = Array.from(contractFuncNames).filter((name) => templateFuncNames.has(name));
        const totalFuncs = Math.max(contractFuncNames.size, templateFuncNames.size);
        const similarity = totalFuncs > 0 ? (matches.length / totalFuncs) * 100 : 0;

        return {
          template: template.name,
          description: template.description,
          similarityPercentage: Math.round(similarity * 100) / 100,
          matchedFunctions: matches,
          totalMatches: matches.length,
        };
      });

      // Persist similarity scores
      for (const sim of similarities) {
        try {
          await (prismaWrite as any).codeSimilarityScore.create({
            data: {
              contractAddress: address,
              templateName: sim.template,
              similarityPercentage: sim.similarityPercentage,
              matchedAreas: sim.matchedFunctions,
              modifiedAreas: [],
            },
          });
        } catch {
          // Ignore unique constraint errors
        }
      }

      return res.json({
        address,
        similarities: similarities.filter((s) => s.similarityPercentage > 0),
      });
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not analyze contract', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/similarity/known-templates — get template match status
contractRouter.get(
  '/:address/source/similarity/known-templates',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const scores = await (prismaRead as any).codeSimilarityScore.findMany({
        where: { contractAddress: address },
        select: { templateName: true, similarityPercentage: true, matchedAreas: true },
      });

      return res.json({
        address,
        templates: scores.map((s: any) => ({
          name: s.templateName,
          similarity: s.similarityPercentage,
          matched: s.matchedAreas.length,
        })),
      });
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not retrieve similarity data', detail: String(err) });
    }
  }),
);

// ── Cross-Contract Reference Graph ──────────────────────────────────────────

// GET /cross-contract/references/:contractAddress — contracts that interact with this one
contractRouter.get(
  '/cross-contract/references/:address',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const references = await (prismaRead as any).crossContractReference.findMany({
        where: {
          OR: [{ sourceContract: address }, { targetContract: address }],
        },
        select: {
          sourceContract: true,
          targetContract: true,
          referenceType: true,
          callCount: true,
        },
      });

      const inbound = references.filter((r: any) => r.targetContract === address);
      const outbound = references.filter((r: any) => r.sourceContract === address);

      return res.json({
        address,
        inbound: inbound.map((r: any) => ({
          contract: r.sourceContract,
          type: r.referenceType,
          calls: r.callCount,
        })),
        outbound: outbound.map((r: any) => ({
          contract: r.targetContract,
          type: r.referenceType,
          calls: r.callCount,
        })),
      });
    } catch (err: any) {
      return res
        .status(500)
        .json({ error: 'Could not retrieve cross-contract references', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/graph — call graph for a contract
contractRouter.get(
  '/:address/source/graph',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      // Persist call graph
      try {
        const graph = analysis.callGraph;
        await (prismaWrite as any).contractCallGraph.create({
          data: {
            contractAddress: address,
            adjacencyList: graph,
            entryPoints: graph.nodes.filter(
              (n: string) =>
                analysis.functions.find((f: any) => f.name === n && f.exportName)?.exportName,
            ),
            depth: calculateGraphDepth(graph),
            numNodes: graph.nodes.length,
            numEdges: graph.edges.length,
          },
        });
      } catch {
        // Non-fatal
      }

      return res.json({
        address,
        graph: analysis.callGraph,
        depth: calculateGraphDepth(analysis.callGraph),
      });
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not retrieve call graph', detail: String(err) });
    }
  }),
);

function calculateGraphDepth(graph: any): number {
  if (!graph.edges || graph.edges.length === 0) return 1;
  const visited = new Set<string>();
  const maxDepthFromNode = (node: string, depth = 0): number => {
    if (visited.has(node) || depth > 100) return depth;
    visited.add(node);
    const neighbors = (graph.edges as any[])
      .filter((e: any) => e.from === node)
      .map((e: any) => e.to);
    if (neighbors.length === 0) return depth;
    return Math.max(...neighbors.map((n) => maxDepthFromNode(n, depth + 1)));
  };
  return Math.max(...(graph.nodes || []).map((n: string) => maxDepthFromNode(n)));
}

// ── Visualization & Quality Metrics ─────────────────────────────────────────

// GET /contracts/:address/source/visualizations/call-graph — D3.js compatible format
contractRouter.get(
  '/:address/source/visualizations/call-graph',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      // Convert to D3.js hierarchical format
      const d3Format = {
        name: address,
        children: analysis.functions.map((fn) => ({
          name: fn.name,
          value: fn.linesOfCode || 0,
          complexity: fn.complexity,
          callCount: fn.calls.length,
        })),
      };

      return res.json(d3Format);
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not visualize call graph', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/visualizations/complexity-radar — complexity metrics
contractRouter.get(
  '/:address/source/visualizations/complexity-radar',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      const lowComplexity = analysis.functions.filter((f) => f.complexity === 'low').length;
      const mediumComplexity = analysis.functions.filter((f) => f.complexity === 'medium').length;
      const highComplexity = analysis.functions.filter((f) => f.complexity === 'high').length;

      return res.json({
        address,
        metrics: [
          { label: 'Low Complexity', value: lowComplexity },
          { label: 'Medium Complexity', value: mediumComplexity },
          { label: 'High Complexity', value: highComplexity },
        ],
      });
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not compute complexity metrics', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/visualizations/function-heatmap — function call frequency
contractRouter.get(
  '/:address/source/visualizations/function-heatmap',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      const heatmap = analysis.functions.map((fn) => ({
        name: fn.name,
        incomingCalls: fn.calls.length,
        storageOps: fn.storageOperations.length,
        hostCalls: fn.hostCalls.length,
        complexity: fn.cyclomaticComplexity,
      }));

      return res.json({ address, heatmap });
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not generate heatmap', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/quality — decompilation quality metrics
contractRouter.get(
  '/:address/source/quality',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      const totalFunctions = analysis.functions.length;
      const functionsWithPseudoCode = analysis.functions.filter(
        (f) => f.pseudoCode && f.pseudoCode.length > 0,
      ).length;
      const functionsWithCFG = analysis.functions.filter(
        (f) => f.cfg && f.cfg.blocks && f.cfg.blocks.length > 0,
      ).length;
      const functionsWithSourceMap = analysis.functions.filter(
        (f) => f.sourceMap && f.sourceMap.length > 0,
      ).length;

      return res.json({
        address,
        metrics: {
          functionRecoveryPercent:
            totalFunctions > 0 ? (functionsWithPseudoCode / totalFunctions) * 100 : 0,
          cfgRecoveryPercent: totalFunctions > 0 ? (functionsWithCFG / totalFunctions) * 100 : 0,
          sourceMapCoverage:
            totalFunctions > 0 ? (functionsWithSourceMap / totalFunctions) * 100 : 0,
          totalFunctions,
          estimatedCompleteness:
            totalFunctions > 0
              ? ((functionsWithPseudoCode + functionsWithCFG + functionsWithSourceMap) /
                  (totalFunctions * 3)) *
                100
              : 0,
        },
      });
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not compute quality metrics', detail: String(err) });
    }
  }),
);

// ── Diff & Export Endpoints ────────────────────────────────────────────────

// GET /contracts/:address/source/diff?otherContract=... — diff two contracts
contractRouter.get(
  '/:address/source/diff',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { otherContract } = req.query as { otherContract?: string };

    if (!otherContract || typeof otherContract !== 'string') {
      return res.status(400).json({ error: 'otherContract parameter required' });
    }

    try {
      const [wasm1, wasm2] = await Promise.all([
        fetchOnChainWasm(address),
        fetchOnChainWasm(otherContract),
      ]);
      const [analysis1, analysis2] = [analyzeWasmContract(wasm1), analyzeWasmContract(wasm2)];

      const funcs1 = new Map(analysis1.functions.map((f) => [f.name, f]));
      const funcs2 = new Map(analysis2.functions.map((f) => [f.name, f]));

      const common = Array.from(funcs1.keys()).filter((name) => funcs2.has(name));
      const unique1 = Array.from(funcs1.keys()).filter((name) => !funcs2.has(name));
      const unique2 = Array.from(funcs2.keys()).filter((name) => !funcs1.has(name));

      return res.json({
        contract1: address,
        contract2: otherContract,
        summary: {
          commonFunctions: common.length,
          uniqueToFirst: unique1.length,
          uniqueToSecond: unique2.length,
        },
        commonFunctions: common,
        uniqueToFirst: unique1,
        uniqueToSecond: unique2,
      });
    } catch (err: any) {
      return res.status(404).json({ error: 'Could not diff contracts', detail: String(err) });
    }
  }),
);

// POST /contracts/source/batch — batch fetch and analyze multiple contracts
contractRouter.post(
  '/source/batch',
  asyncHandler(async (req: Request, res: Response) => {
    const { addresses } = req.body as { addresses?: string[] };

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses array required' });
    }

    try {
      const results = await Promise.allSettled(
        addresses.slice(0, 100).map(async (addr) => {
          const wasm = await fetchOnChainWasm(addr);
          const analysis = analyzeWasmContract(wasm);
          return {
            address: addr,
            functionCount: analysis.functions.length,
            wasmHash: analysis.wasmHash,
          };
        }),
      );

      const successes = results.filter((r) => r.status === 'fulfilled').map((r: any) => r.value);
      const failures = results
        .filter((r) => r.status === 'rejected')
        .map((r: any, idx) => ({ address: addresses[idx], error: String(r.reason) }));

      return res.json({
        totalRequested: addresses.length,
        processed: successes.length,
        failed: failures.length,
        results: successes,
        errors: failures.length > 0 ? failures : undefined,
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Batch processing failed', detail: String(err) });
    }
  }),
);

// GET /contracts/:address/source/export?format=json — export analysis
contractRouter.get(
  '/:address/source/export',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { format = 'json' } = req.query as { format?: string };

    if (format !== 'json') {
      return res.status(400).json({ error: 'Only JSON export currently supported' });
    }

    try {
      const wasm = await fetchOnChainWasm(address);
      const analysis = analyzeWasmContract(wasm);

      // Set download header
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="contract_${address.slice(0, 8)}_analysis.json"`,
      );
      res.setHeader('Content-Type', 'application/json');

      return res.json(analysis);
    } catch (err: any) {
      return res
        .status(404)
        .json({ error: 'Could not export contract analysis', detail: String(err) });
    }
  }),
);
