/**
 * Protocol 26 State Extension API Router
 *
 * Handles Stellar Protocol 26 features including state archival, contract
 * instance TTL management, persistent/temporary entry management, and
 * footprint optimization for Soroban smart contracts.
 *
 * The POST /contracts/:contractId/extend-ttl endpoint now performs a real
 * Soroban RPC simulateTransaction call instead of returning a hardcoded
 * "simulated" stub (fix for issue #636).
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  SorobanRpc,
  TransactionBuilder,
  Account,
  Operation,
  BASE_FEE,
  xdr,
} from '@stellar/stellar-sdk';
import { rpc } from '../indexer/rpc';
import { config } from '../config';
import { asyncHandler } from '../middleware/asyncHandler';

export const protocol26Router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const ContractTtlSchema = z.object({
  contractId: z.string().min(1),
  ledgersToLive: z.number().int().min(1).max(3110400), // max ~6 months
  entryType: z.enum(['instance', 'persistent', 'temporary']).default('instance'),
});

const FootprintSchema = z.object({
  contractId: z.string().min(1),
  readOnly: z.array(z.string()).default([]),
  readWrite: z.array(z.string()).default([]),
});

// Dummy source account for simulation-only transactions (never submitted)
const DUMMY_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

// ── GET / ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26:
 *   get:
 *     summary: Protocol 26 state extension service overview
 *     tags: [Protocol 26]
 *     responses:
 *       200:
 *         description: Service info and Protocol 26 features
 */
protocol26Router.get('/', (_req: Request, res: Response) => {
  res.json({
    protocol: 26,
    name: 'Stellar Protocol 26 State Extension',
    description:
      'Manages state archival, TTL, and Soroban entry lifecycle introduced in Protocol 26',
    features: [
      'Contract state archival (automatic & manual)',
      'TTL (Time-To-Live) management for entries',
      'Persistent vs. temporary storage entries',
      'Footprint optimization',
      'State restore operations',
      'Ledger entry expiration tracking',
    ],
    endpoints: [
      'GET  /protocol26',
      'GET  /protocol26/contracts/:contractId/ttl',
      'POST /protocol26/contracts/:contractId/extend-ttl',
      'GET  /protocol26/contracts/:contractId/entries',
      'GET  /protocol26/archive/stats',
      'POST /protocol26/footprint/optimize',
      'GET  /protocol26/expiring',
    ],
  });
});

// ── GET /contracts/:contractId/ttl ─────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/ttl:
 *   get:
 *     summary: Get TTL information for a contract's state entries
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: TTL data for contract entries
 *       404:
 *         description: Contract not found
 */
protocol26Router.get('/contracts/:contractId/ttl', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const currentLedger = Math.floor(Date.now() / 5000); // approximate ledger number

  res.json({
    contractId,
    currentLedger,
    entries: {
      instance: {
        entryType: 'instance',
        liveUntilLedger: currentLedger + 518400, // ~30 days
        ttlRemaining: 518400,
        archived: false,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      },
      persistentEntries: {
        count: 0,
        avgTtlRemaining: 0,
        nearExpiry: 0,
      },
      temporaryEntries: {
        count: 0,
        avgTtlRemaining: 0,
        nearExpiry: 0,
      },
    },
    archivalPolicy: {
      minPersistentTtl: 4096,
      maxPersistentTtl: 3110400,
      minTemporaryTtl: 1,
      maxTemporaryTtl: 518400,
    },
  });
});

// ── POST /contracts/:contractId/extend-ttl ──────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/extend-ttl:
 *   post:
 *     summary: Extend the TTL for a contract's state entries
 *     description: >
 *       Builds an ExtendFootprintTTLOp transaction and simulates it against the
 *       Soroban RPC to return real status, resource usage, and fee estimates.
 *       Submit the returned transaction XDR to the Stellar network to apply.
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ledgersToLive]
 *             properties:
 *               ledgersToLive:
 *                 type: number
 *                 description: Number of ledgers to extend the entry TTL by
 *               entryType:
 *                 type: string
 *                 enum: [instance, persistent, temporary]
 *     responses:
 *       200:
 *         description: TTL extension simulation result
 *       400:
 *         description: Validation error
 *       502:
 *         description: RPC request failed
 */
protocol26Router.post(
  '/contracts/:contractId/extend-ttl',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = ContractTtlSchema.safeParse({
      contractId: req.params.contractId,
      ...req.body,
    });
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { contractId, ledgersToLive, entryType } = parsed.data;
    const currentLedger = Math.floor(Date.now() / 5000);
    const newLiveUntilLedger = currentLedger + ledgersToLive;

    try {
      // Build a real ExtendFootprintTTLOp transaction for simulation
      const txAccount = new Account(DUMMY_SOURCE, '0');

      // Build the ledger key for the contract entry based on entryType
      let ledgerKey: xdr.LedgerKey;
      try {
        const contractIdBytes = xdr.ScAddress.fromXDR(
          xdr.ScAddress.envelopeTypeScp().toXDR('base64')
        );
        // Use the contract ID hash directly
        const contractIdHash = Buffer.from(contractId, 'hex');

        switch (entryType) {
          case 'instance':
            ledgerKey = xdr.LedgerKey.contractData(
              new xdr.LedgerKeyContractData({
                contract: xdr.ScAddress.contract(
                  xdr.Hash.fromXDR(contractIdHash)
                ),
                key: xdr.ScVal.scvLedgerKeyContractInstance(),
                durability: xdr.ContractDataDurability.persistent(),
              }),
            );
            break;
          case 'persistent':
            ledgerKey = xdr.LedgerKey.contractData(
              new xdr.LedgerKeyContractData({
                contract: xdr.ScAddress.contract(
                  xdr.Hash.fromXDR(contractIdHash)
                ),
                key: xdr.ScVal.scvSymbol('__storage_persistent'),
                durability: xdr.ContractDataDurability.persistent(),
              }),
            );
            break;
          case 'temporary':
            ledgerKey = xdr.LedgerKey.contractData(
              new xdr.LedgerKeyContractData({
                contract: xdr.ScAddress.contract(
                  xdr.Hash.fromXDR(contractIdHash)
                ),
                key: xdr.ScVal.scvSymbol('__storage_temporary'),
                durability: xdr.ContractDataDurability.temporary(),
              }),
            );
            break;
          default:
            ledgerKey = xdr.LedgerKey.contractData(
              new xdr.LedgerKeyContractData({
                contract: xdr.ScAddress.contract(
                  xdr.Hash.fromXDR(contractIdHash)
                ),
                key: xdr.ScVal.scvLedgerKeyContractInstance(),
                durability: xdr.ContractDataDurability.persistent(),
              }),
            );
        }
      } catch {
        return res.status(400).json({
          error: 'Invalid contract ID format',
          detail: 'Contract ID must be a valid hex-encoded hash',
        });
      }

      // Build the extend operation with the ledger key in the footprint
      const extendOp = Operation.extendFootprintTtl({
        extendTo: newLiveUntilLedger,
      });

      // Build the transaction with the proper footprint
      const tx = new TransactionBuilder(txAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
        // Set the soroban data with the footprint
        sorobanData: new xdr.SorobanTransactionData({
          extensionPoint: xdr.ExtensionPoint.extensionPointLeV0(),
          resources: new xdr.SorobanResources({
            ledgerReadWrite: [
              ledgerKey,
            ],
            instructions: 0,
            readBytes: 0,
          }),
          resourceFee: xdr.Int64.fromString('0'),
        }),
      })
        .addOperation(extendOp)
        .setTimeout(0) // Use 0 timeout for simulation
        .build();

      // Simulate the transaction against the Soroban RPC
      const simulationResult = await rpc.simulateTransaction(tx);

      // Check if the simulation succeeded or returned a restore/error response
      if (
        SorobanRpc.Api.isSimulationSuccess(simulationResult) ||
        SorobanRpc.Api.isSimulationRestore(simulationResult)
      ) {
        // Extract resource info
        const cpuInsns = Number(
          (simulationResult.cost as SorobanRpc.Api.Cost)?.cpuInsns ?? 0,
        );
        const memBytes = Number(
          (simulationResult.cost as SorobanRpc.Api.Cost)?.memBytes ?? 0,
        );
        const minResourceFee = simulationResult.minResourceFee ?? '0';

        return res.json({
          contractId,
          entryType,
          operation: 'extend_ttl',
          ledgersExtended: ledgersToLive,
          newLiveUntilLedger,
          status: 'success',
          simulation: {
            minResourceFee,
            cpuInstructions: cpuInsns,
            memoryBytes: memBytes,
            transactionXdr: simulationResult.transactionData
              ? simulationResult.transactionData.toXDR('base64')
              : null,
            result: simulationResult.result?.retval
              ? simulationResult.result.retval.toXDR('base64')
              : null,
          },
          estimatedFeeLumens: Math.ceil(
            Number(minResourceFee) / 10_000_000,
          ),
          note: 'Submit this transaction or a newly built one with the returned footprint to the Stellar network to apply.',
          expiresAt: new Date(newLiveUntilLedger * 5000).toISOString(),
          submittedAt: new Date().toISOString(),
          raw: simulationResult,
        });
      }

      // Simulation returned an error
      const errorResult = simulationResult as SorobanRpc.Api.SimulateTransactionErrorResponse;
      return res.status(422).json({
        contractId,
        entryType,
        operation: 'extend_ttl',
        ledgersExtended: ledgersToLive,
        newLiveUntilLedger,
        status: 'failed',
        error: errorResult.error ?? 'Simulation failed',
        diagnostics: {
          rpcError: errorResult.error,
        },
        note: 'The simulation failed. The contract may not exist or the entry type may be incorrect.',
        submittedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errorMessage.toLowerCase().includes('timeout') ||
        errorMessage.toLowerCase().includes('timed out');

      return res.status(isTimeout ? 504 : 502).json({
        contractId,
        entryType,
        operation: 'extend_ttl',
        ledgersExtended: ledgersToLive,
        newLiveUntilLedger,
        status: 'error',
        error: isTimeout ? 'Simulation timed out' : 'RPC request failed',
        detail: errorMessage,
        note: 'Could not reach the Soroban RPC node. Please try again later.',
        submittedAt: new Date().toISOString(),
      });
    }
  }),
);

// ── GET /contracts/:contractId/entries ──────────────────────────────────────────

/**
 * @swagger
 * /protocol26/contracts/{contractId}/entries:
 *   get:
 *     summary: List persistent and temporary storage entries for a contract
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [persistent, temporary, all] }
 *       - in: query
 *         name: nearExpiry
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Contract storage entries
 */
protocol26Router.get('/contracts/:contractId/entries', (req: Request, res: Response) => {
  const { contractId } = req.params;
  const type = (req.query.type as string) ?? 'all';
  const nearExpiry = req.query.nearExpiry === 'true';

  res.json({
    contractId,
    filter: { type, nearExpiry },
    entries: [],
    total: 0,
    message: 'No state entries found. Entries appear here after indexing contract activity.',
    currentLedger: Math.floor(Date.now() / 5000),
  });
});

// ── GET /archive/stats ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/archive/stats:
 *   get:
 *     summary: Get archival statistics for the network
 *     tags: [Protocol 26]
 *     responses:
 *       200:
 *         description: Archive statistics
 */
protocol26Router.get('/archive/stats', (_req: Request, res: Response) => {
  res.json({
    totalArchivedContracts: 0,
    totalArchivedEntries: 0,
    totalRestoredContracts: 0,
    archivalRate: '0 entries/day',
    storageReclaimed: '0 bytes',
    activeContracts: 0,
    nearExpiryContracts: 0,
    lastUpdated: new Date().toISOString(),
  });
});

// ── POST /footprint/optimize ──────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/footprint/optimize:
 *   post:
 *     summary: Optimize a transaction footprint for Protocol 26 state access
 *     tags: [Protocol 26]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId]
 *             properties:
 *               contractId: { type: string }
 *               readOnly: { type: array, items: { type: string } }
 *               readWrite: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Optimized footprint
 *       400:
 *         description: Validation error
 */
protocol26Router.post('/footprint/optimize', (req: Request, res: Response) => {
  const parsed = FootprintSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { contractId, readOnly, readWrite } = parsed.data;
  const duplicates = readOnly.filter((k) => readWrite.includes(k));
  const optimizedReadOnly = readOnly.filter((k) => !readWrite.includes(k));

  res.json({
    contractId,
    original: { readOnly: readOnly.length, readWrite: readWrite.length },
    optimized: { readOnly: optimizedReadOnly.length, readWrite: readWrite.length },
    removedDuplicates: duplicates.length,
    duplicateKeys: duplicates,
    recommendation:
      duplicates.length > 0
        ? 'Removed duplicate keys present in both readOnly and readWrite sets'
        : 'Footprint is already optimized',
    estimatedFeeReduction: duplicates.length > 0 ? `~${duplicates.length * 0.0001} XLM` : '0 XLM',
  });
});

// ── GET /expiring ──────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /protocol26/expiring:
 *   get:
 *     summary: List contracts with state entries expiring soon
 *     tags: [Protocol 26]
 *     parameters:
 *       - in: query
 *         name: ledgersThreshold
 *         schema: { type: number }
 *         description: Warn if TTL < this many ledgers (default 50000, ~3 days)
 *     responses:
 *       200:
 *         description: Contracts near expiry
 */
protocol26Router.get('/expiring', (req: Request, res: Response) => {
  const threshold = Math.min(
    518400,
    parseInt((req.query.ledgersThreshold as string) ?? '50000', 10),
  );

  res.json({
    threshold,
    thresholdDescription: `~${Math.round((threshold * 5) / 3600)} hours`,
    expiringContracts: [],
    total: 0,
    message: 'No contracts found near expiry threshold.',
    checkedAt: new Date().toISOString(),
  });
});