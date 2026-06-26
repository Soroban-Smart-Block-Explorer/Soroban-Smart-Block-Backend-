import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveContractFunctions } from '../playground/abi-resolver';
import { readContract, buildSignableTransaction, submitTransaction } from '../playground/tx-builder';
import { prisma } from '../db';

export const playgroundRouter = Router({ mergeParams: true });

const scValInputSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('void') }),
    z.object({ type: z.literal('bool'), value: z.boolean() }),
    z.object({ type: z.literal('u32'), value: z.number() }),
    z.object({ type: z.literal('i32'), value: z.number() }),
    z.object({ type: z.literal('u64'), value: z.union([z.string(), z.number()]) }),
    z.object({ type: z.literal('i64'), value: z.union([z.string(), z.number()]) }),
    z.object({ type: z.literal('u128'), value: z.string() }),
    z.object({ type: z.literal('i128'), value: z.string() }),
    z.object({ type: z.literal('string'), value: z.string() }),
    z.object({ type: z.literal('symbol'), value: z.string() }),
    z.object({ type: z.literal('address'), value: z.string() }),
    z.object({ type: z.literal('bytes'), value: z.string() }),
    z.object({ type: z.literal('vec'), items: z.array(scValInputSchema) }),
    z.object({
      type: z.literal('map'),
      entries: z.array(z.object({ key: scValInputSchema, value: scValInputSchema })),
    }),
    z.object({ type: z.literal('option'), inner: z.union([scValInputSchema, z.null()]) }),
    z.object({ type: z.literal('native'), value: z.unknown() }),
  ]),
);

const readRequestSchema = z.object({
  functionName: z.string().min(1),
  args: z.array(scValInputSchema).default([]),
  sourceAccount: z.string().optional(),
});

const buildTxSchema = z.object({
  functionName: z.string().min(1),
  args: z.array(scValInputSchema).default([]),
  sourceAccount: z.string().min(1),
  fee: z.string().optional(),
});

const submitSchema = z.object({
  signedXdr: z.string().min(1),
});

/**
 * GET /contracts/:address/playground/functions
 * Discover available functions from WASM / ABI / SEP-41 fallback
 */
playgroundRouter.get('/functions', async (req: Request, res: Response) => {
  const { address } = req.params;
  try {
    const resolved = await resolveContractFunctions(address);
    res.json(resolved);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /contracts/:address/read
 * Invoke a read-only (view) function and return decoded result
 */
playgroundRouter.post('/read', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = readRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await readContract(address, parsed.data);
  const status = result.success ? 200 : 400;
  return res.status(status).json(result);
});

/**
 * POST /contracts/:address/simulate
 * Simulate a state-changing transaction (no signing needed) — shows state changes
 */
playgroundRouter.post('/simulate', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = buildTxSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await buildSignableTransaction(address, parsed.data);
  const status = result.simulationSuccess ? 200 : 400;
  return res.status(status).json({
    ...result,
    preview: result.simulationSuccess
      ? {
          functionName: result.functionName,
          estimatedFee: result.estimatedFee,
          simulationResult: result.simulationResult,
          resources: result.estimatedResources,
        }
      : null,
  });
});

/**
 * POST /contracts/:address/build-tx
 * Build an unsigned transaction envelope ready for signing
 */
playgroundRouter.post('/build-tx', async (req: Request, res: Response) => {
  const { address } = req.params;
  const parsed = buildTxSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await buildSignableTransaction(address, parsed.data);
  if (!result.simulationSuccess) {
    return res.status(400).json({ error: result.error });
  }
  return res.json({
    unsignedXdr: result.unsignedXdr,
    functionName: result.functionName,
    estimatedFee: result.estimatedFee,
    resources: result.estimatedResources,
    instructions: 'Sign the unsignedXdr with your Stellar keypair and submit via POST /submit',
  });
});

/**
 * POST /contracts/:address/submit
 * Submit a signed transaction XDR to the network
 */
playgroundRouter.post('/submit', async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await submitTransaction(parsed.data);
  const status = result.status === 'error' ? 400 : 200;
  return res.status(status).json(result);
});

/**
 * GET /contracts/:address/history
 * Return historical transaction inputs as example defaults
 */
playgroundRouter.get('/history', async (req: Request, res: Response) => {
  const { address } = req.params;
  const fn = req.query.function as string | undefined;

  try {
    const txs = await prisma.transaction.findMany({
      where: {
        contractAddress: address,
        ...(fn ? { functionName: fn } : {}),
        functionArgs: { not: undefined },
      },
      select: { functionName: true, functionArgs: true, ledger: true, hash: true },
      orderBy: { ledger: 'desc' },
      take: 20,
    });

    res.json({
      address,
      examples: txs.map((t) => ({
        functionName: t.functionName,
        args: t.functionArgs,
        ledger: t.ledger,
        txHash: t.hash,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
