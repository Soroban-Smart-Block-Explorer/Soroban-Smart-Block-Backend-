import { Router, Request, Response } from 'express';
import { SorobanRpc, xdr, scValToNative, Address } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';
import { validateAddressParam } from '../middleware/sanitize';
import { rpc } from '../indexer/rpc';
import { config } from '../config';

export const tokenRouter = Router();

// GET /tokens — list all SEP-41 tokens
tokenRouter.get('/', async (_req: Request, res: Response) => {
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
});

// GET /tokens/:address
tokenRouter.get('/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  const token = await prisma.contract.findFirst({
    where: { address: req.params.address, isToken: true },
  });
  if (!token) return res.status(404).json({ error: 'Token not found' });
  res.json(token);
});

// GET /tokens/:address/transfers
tokenRouter.get('/:address/transfers', validateAddressParam('address'), async (req: Request, res: Response) => {
  const events = await prisma.event.findMany({
    where: { contractAddress: req.params.address, eventType: 'transfer' },
    orderBy: { ledgerSequence: 'desc' },
    take: 50,
    select: { id: true, transactionHash: true, decoded: true, ledgerSequence: true, ledgerCloseTime: true },
  });
  res.json(events);
});

/**
 * GET /tokens/:address/balance/:account
 * Query the current balance of an account for a given token contract.
 * Calls SEP-41 balance(address) via Soroban RPC simulateTransaction.
 *
 * Returns: { address, account, balance, symbol, decimals }
 * Returns 404 if the contract is not a registered token.
 * Returns 502 if RPC simulation fails.
 */
tokenRouter.get('/:address/balance/:account', validateAddressParam('address'), validateAddressParam('account'), async (req: Request, res: Response) => {
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
});
