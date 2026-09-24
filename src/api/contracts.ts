import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { abiRouter } from './abi';
import { archiveRouter } from './archive';
import { validateAddressParam, isValidStellarAddress } from '../middleware/sanitize';
import { contractAuditRouter } from './contract-audit';
import { asyncHandler } from '../middleware/asyncHandler';
import { config } from '../config';
import { getProtocolDeployments } from '../indexer/registry';

/**
 * @swagger
 * tags:
 *   name: Contracts
 *   description: Registered and indexed Soroban contracts, ABI metadata, and simulation
 */

export const contractRouter = Router();

contractRouter.use('/:address/abi', abiRouter);
contractRouter.use('/:address/state', archiveRouter);

const stellarAddress = z
  .string()
  .refine(isValidStellarAddress, { message: 'Invalid Stellar contract address' });

const abiSchema = z.object({
  address: stellarAddress,
  /** Network the address belongs to. Defaults to the active profile. */
  network: z.string().min(1).max(32).optional(),
  /** Canonical registry record to attach this deployment to. Defaults to `address`. */
  canonicalAddress: stellarAddress.optional(),
  name: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  abi: z.record(z.unknown()).optional(),
  /** Network-keyed ABI + version metadata. */
  abiVersion: z.string().max(64).optional(),
  abiHash: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  wasmHash: z.string().max(64).optional(),
  /** Linkage hint grouping the same protocol deployed across networks. */
  protocolKey: z.string().min(1).max(128).optional(),
  isCanonical: z.boolean().optional(),
  deployedAtLedger: z.number().int().nonnegative().optional(),
});

const contractStatsQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

const contractsListQuerySchema = z.object({
  network: z.string().min(1).max(32).optional(),
  protocolKey: z.string().min(1).max(128).optional(),
});

/** Deployment summary fields shared by the list, detail, and protocol routes. */
const networkDeploymentSelect = {
  address: true,
  network: true,
  abiVersion: true,
  abiHash: true,
  version: true,
  wasmHash: true,
  protocolKey: true,
  isCanonical: true,
  deployedAtLedger: true,
} as const;

const deploymentOrderBy = [{ isCanonical: 'desc' as const }, { network: 'asc' as const }];

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
 * /contracts:
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
  asyncHandler(async (req: Request, res: Response) => {
    const query = contractsListQuerySchema.parse(req.query);

    // Backwards compatible: without a network/protocol filter, return the same
    // flat summary as before so existing clients are unaffected.
    if (!query.network && !query.protocolKey) {
      const contracts = await prismaRead.contract.findMany({
        select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
        orderBy: { createdAt: 'desc' },
      });
      return res.json(contracts);
    }

    const deploymentWhere: { network?: string; protocolKey?: string } = {};
    if (query.network) deploymentWhere.network = query.network;
    if (query.protocolKey) deploymentWhere.protocolKey = query.protocolKey;

    const contracts = await prismaRead.contract.findMany({
      where: { networkDeployments: { some: deploymentWhere } },
      select: {
        address: true,
        name: true,
        description: true,
        isToken: true,
        tokenSymbol: true,
        networkDeployments: {
          where: deploymentWhere,
          select: networkDeploymentSelect,
          orderBy: deploymentOrderBy,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(contracts);
  }),
);

/**
 * @swagger
 * /api/v1/contracts/protocol/{protocolKey}:
 *   get:
 *     summary: List every network deployment grouped under one protocol key
 *     tags: [Contracts]
 *     parameters:
 *       - in: path
 *         name: protocolKey
 *         required: true
 *         schema: { type: string }
 *         description: Linkage hint shared by deployments of the same protocol
 *     responses:
 *       200:
 *         description: Deployments across networks, canonical first then by network
 *       404:
 *         description: No deployments registered for this protocol key
 */
// GET /contracts/protocol/:protocolKey
contractRouter.get(
  '/protocol/:protocolKey',
  asyncHandler(async (req: Request, res: Response) => {
    const deployments = await getProtocolDeployments(req.params.protocolKey);
    if (deployments.length === 0) {
      return res.status(404).json({ error: 'No deployments found for protocol key' });
    }
    return res.json({
      protocolKey: req.params.protocolKey,
      networks: [...new Set(deployments.map((d) => d.network))].sort(),
      deployments,
    });
  }),
);

/**
 * @swagger
 * /contracts/{address}/stats:
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
 * /contracts/{address}:
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
        networkDeployments: {
          select: networkDeploymentSelect,
          orderBy: deploymentOrderBy,
        },
      },
    });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    res.json(contract);
  }),
);

/**
 * @swagger
 * /contracts:
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
 *               address: { type: string, description: 'Stellar contract address on `network` (validated)' }
 *               network: { type: string, maxLength: 32, description: 'Network the address belongs to; defaults to the active profile' }
 *               canonicalAddress: { type: string, description: 'Canonical Contract record to attach the deployment to; defaults to address' }
 *               name: { type: string, maxLength: 256 }
 *               description: { type: string, maxLength: 2048 }
 *               abi: { type: object, description: 'Network-keyed ABI metadata (functions, events, types)' }
 *               abiVersion: { type: string, maxLength: 64 }
 *               abiHash: { type: string, maxLength: 64 }
 *               version: { type: string, maxLength: 64 }
 *               wasmHash: { type: string, maxLength: 64, description: 'Deployed WASM hash on this network' }
 *               protocolKey: { type: string, maxLength: 128, description: 'Linkage hint grouping deployments of the same protocol across networks' }
 *               isCanonical: { type: boolean, description: 'Marks the reference deployment within a protocol group' }
 *               deployedAtLedger: { type: integer, minimum: 0 }
 *             example:
 *               address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *               network: testnet
 *               name: USD Coin
 *               description: USDC stablecoin token contract
 *               protocolKey: usdc
 *               abiVersion: 1.0.0
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
export type ContractRegistrationInput = z.infer<typeof abiSchema>;

/**
 * Register or update contract metadata, optionally scoped to a network.
 *
 * Without `network` this preserves the original address-keyed Contract upsert.
 * With `network` it additionally upserts a ContractNetwork deployment, deduped
 * on (address, network), linked to the canonical Contract record. Network-keyed
 * ABI/version data then takes precedence in registry lookups.
 */
export async function registerContractMetadata(data: ContractRegistrationInput) {
  // A deployment always resolves to a canonical Contract record; when the
  // caller does not name a different one, the address doubles as canonical.
  const canonicalAddress = data.canonicalAddress ?? data.address;

  const contract = await prismaWrite.contract.upsert({
    where: { address: canonicalAddress },
    update: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.abi !== undefined ? { abi: data.abi as object } : {}),
    },
    create: {
      address: canonicalAddress,
      name: data.name,
      description: data.description,
      abi: data.abi as object,
    },
  });

  // No network given → keep the original address-only registration path.
  if (data.network === undefined) return { contract, deployment: null };

  const network = data.network;

  // Dedupe on (address, network): re-registering the same address on the same
  // network updates the existing deployment instead of inserting a new row.
  const deployment = await prismaWrite.contractNetwork.upsert({
    where: { address_network: { address: data.address, network } },
    update: {
      contractId: contract.id,
      ...(data.abi !== undefined ? { abi: data.abi as object } : {}),
      ...(data.abiVersion !== undefined ? { abiVersion: data.abiVersion } : {}),
      ...(data.abiHash !== undefined ? { abiHash: data.abiHash } : {}),
      ...(data.version !== undefined ? { version: data.version } : {}),
      ...(data.wasmHash !== undefined ? { wasmHash: data.wasmHash } : {}),
      ...(data.protocolKey !== undefined ? { protocolKey: data.protocolKey } : {}),
      ...(data.isCanonical !== undefined ? { isCanonical: data.isCanonical } : {}),
      ...(data.deployedAtLedger !== undefined ? { deployedAtLedger: data.deployedAtLedger } : {}),
    },
    create: {
      address: data.address,
      network,
      contractId: contract.id,
      abi: data.abi as object,
      abiVersion: data.abiVersion,
      abiHash: data.abiHash,
      version: data.version,
      wasmHash: data.wasmHash,
      protocolKey: data.protocolKey,
      isCanonical: data.isCanonical ?? false,
      deployedAtLedger: data.deployedAtLedger,
    },
  });

  return { contract, deployment };
}

// POST /contracts — register ABI metadata (optionally per network)
contractRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = abiSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    }

    try {
      const { contract, deployment } = await registerContractMetadata(parsed.data);
      return res.status(201).json(deployment ?? contract);
    } catch (e) {
      return res.status(400).json({ error: String(e) });
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
