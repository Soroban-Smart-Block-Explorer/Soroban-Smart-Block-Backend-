import { Router, Request, Response } from 'express';
import { SorobanRpc, xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';
import { validateAddressParam } from '../middleware/sanitize';
import { rpc } from '../indexer/rpc';
import { config } from '../config';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: Tokens
 *   description: SEP-41 token contracts, transfers, and balances
 */

export const tokenRouter = Router();

/**
 * @swagger
 * /api/v1/tokens:
 *   get:
 *     summary: List all SEP-41 tokens
 *     description: Returns every contract flagged as a token, sorted by symbol.
 *     tags: [Tokens]
 *     responses:
 *       200:
 *         description: List of tokens (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Token' }
 */
// GET /tokens — list all SEP-41 tokens
tokenRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const tokens = await prisma.contract.findMany({
      where: { isToken: true },
      select: {
        address: true,
        tokenName: true,
        tokenSymbol: true,
        tokenDecimals: true,
      },
      orderBy: { tokenSymbol: 'asc' },
    });
    res.json(tokens);
  }),
);

/**
 * @swagger
 * /api/v1/tokens/{address}:
 *   get:
 *     summary: Get a single token by contract address
 *     description: Returns the full contract record for a contract flagged as a token.
 *     tags: [Tokens]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Token contract address
 *     responses:
 *       200:
 *         description: The full contract record for this token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Contract' }
 *       400:
 *         description: Invalid Stellar address
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 *       404:
 *         description: Contract is not a registered token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Token not found'
 */
// GET /tokens/:address
tokenRouter.get(
  '/:address',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const token = await prisma.contract.findFirst({
      where: { address: req.params.address, isToken: true },
    });
    if (!token) return res.status(404).json({ error: 'Token not found' });
    res.json(token);
  }),
);

/**
 * @swagger
 * /api/v1/tokens/{address}/transfers:
 *   get:
 *     summary: List recent transfer events for a token
 *     description: Returns up to 50 of the most recent transfer events for this token, newest first.
 *     tags: [Tokens]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Token contract address
 *     responses:
 *       200:
 *         description: Up to 50 transfer events (summary fields only)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 description: Transfer event summary (subset of the full Event record)
 *                 properties:
 *                   id: { type: string }
 *                   transactionHash: { type: string }
 *                   decoded: { type: object, nullable: true, description: 'Decoded transfer payload (from, to, amount)' }
 *                   ledgerSequence: { type: integer }
 *                   ledgerCloseTime: { type: string, format: date-time }
 *               example:
 *                 - id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg=='
 *                   transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                   decoded: { from: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI', to: 'CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5', amount: '1000000000' }
 *                   ledgerSequence: 3168075
 *                   ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *       400:
 *         description: Invalid Stellar address
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 */
// GET /tokens/:address/transfers
tokenRouter.get(
  '/:address/transfers',
  validateAddressParam('address'),
  asyncHandler(async (req: Request, res: Response) => {
    const events = await prisma.event.findMany({
      where: { contractAddress: req.params.address, eventType: 'transfer' },
      orderBy: { ledgerSequence: 'desc' },
      take: 50,
      select: {
        id: true,
        transactionHash: true,
        decoded: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
      },
    });
    res.json(events);
  }),
);

/**
 * @swagger
 * /api/v1/tokens/{address}/balance/{account}:
 *   get:
 *     summary: Get an account's token balance
 *     description: >-
 *       Reads the current balance by calling the SEP-41 `balance(address)` function
 *       through a Soroban RPC simulation. The balance is returned in raw base units;
 *       apply `decimals` to get the display value.
 *     tags: [Tokens]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Token contract address
 *       - in: path
 *         name: account
 *         required: true
 *         schema: { type: string }
 *         description: Account address (G...) to read the balance for
 *     responses:
 *       200:
 *         description: The account's current token balance
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 address: { type: string, description: 'Token contract address' }
 *                 account: { type: string, description: 'Account the balance was read for' }
 *                 balance: { type: string, description: 'Raw balance in base units; apply decimals to get the display value' }
 *                 symbol: { type: string, nullable: true }
 *                 decimals: { type: integer, nullable: true }
 *               example:
 *                 address: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                 account: GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI
 *                 balance: '1000000000'
 *                 symbol: USDC
 *                 decimals: 7
 *       400:
 *         description: Invalid Stellar address (contract or account)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Invalid Stellar address: GBADDRESS'
 *       404:
 *         description: Contract is not a registered token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: 'Token not found'
 *       502:
 *         description: Soroban RPC simulation failed or returned an unusable response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *                 detail: { type: string, description: 'Underlying RPC error or reason' }
 *               example:
 *                 error: RPC simulation failed
 *                 detail: 'HostError: Error(Contract, #5)'
 */
tokenRouter.get(
  '/:address/balance/:account',
  validateAddressParam('address'),
  validateAddressParam('account'),
  asyncHandler(async (req: Request, res: Response) => {
    const { address, account } = req.params;

    // Check if the contract is a registered token
    const token = await prisma.contract.findFirst({
      where: { address, isToken: true },
      select: {
        address: true,
        tokenSymbol: true,
        tokenDecimals: true,
      },
    });

    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    try {
      // Build the balance(address) call
      const invokeHostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(address).toScAddress() as any,
          functionName: 'balance',
          args: [new Address(account).toScAddress() as any],
        }),
      );

      // Build a minimal transaction for simulation
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TransactionBuilder, Account, Operation, BASE_FEE } = require('@stellar/stellar-sdk');
      const DUMMY_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
      const txAccount = new Account(DUMMY_SOURCE, '0');
      const simulateTx = new TransactionBuilder(txAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(Operation.invokeHostFunction({ func: invokeHostFn, auth: [] }))
        .setTimeout(30)
        .build();

      // Simulate the transaction
      const result = await rpc.simulateTransaction(simulateTx);

      // Check for simulation errors
      if (SorobanRpc.Api.isSimulationError(result)) {
        return res.status(502).json({
          error: 'RPC simulation failed',
          detail: (result as SorobanRpc.Api.SimulateTransactionErrorResponse).error,
        });
      }

      // Extract the balance value from the result
      if (!('result' in result) || !result.result) {
        return res.status(502).json({
          error: 'Invalid RPC response',
          detail: 'No result field in simulation response',
        });
      }

      const retVal = (result.result as any).retval as xdr.ScVal | undefined;
      if (!retVal) {
        return res.status(502).json({
          error: 'Invalid RPC response',
          detail: 'No return value in simulation result',
        });
      }

      // Decode the balance (i128 or i64)
      const balanceValue = scValToNative(retVal);

      return res.json({
        address,
        account,
        balance: String(balanceValue),
        symbol: token.tokenSymbol,
        decimals: token.tokenDecimals,
      });
    } catch (err) {
      console.error('[token-balance] Simulation error:', err);
      return res.status(502).json({
        error: 'RPC request failed',
        detail: String(err),
      });
    }
  }),
);
