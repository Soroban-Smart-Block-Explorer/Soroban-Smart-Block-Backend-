import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getCachedAbi, setCachedAbi, deleteCachedAbi } from '../indexer/abi-cache';
import { fetchContractSpec } from '../indexer/wasm-spec';
import { asyncHandler } from '../middleware/asyncHandler';

export const abiRouter = Router({ mergeParams: true });

const abiFunctionSchema = z.object({
  name: z.string().min(1),
  inputs: z.array(z.object({ name: z.string(), type: z.string() })),
  outputs: z.array(z.object({ type: z.string() })).optional(),
  humanTemplate: z.string().optional(),
});

const abiBodySchema = z.object({
  functions: z.array(abiFunctionSchema).min(1),
});

/**
 * GET /contracts/:address/abi
 * Priority: 1) on-chain Wasm spec  2) manually stored ABI
 */
abiRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    // 1. Try on-chain spec first
    const onChain = await fetchContractSpec(address);
    if (onChain) return res.json({ source: 'on-chain', abi: onChain });

    // 2. Fall back to stored ABI
    const stored = await getCachedAbi(address);
    if (stored) return res.json({ source: 'manual', abi: stored });

    res.status(404).json({ error: 'No ABI found. Upload one via PUT /contracts/:address/abi' });
  }),
);

/**
 * PUT /contracts/:address/abi
 * Create or replace the manually stored ABI.
 */
abiRouter.put(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const parsed = abiBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    await setCachedAbi(address, parsed.data);
    res.json({ address, abi: parsed.data });
  }),
);

/**
 * DELETE /contracts/:address/abi
 * Remove the manually stored ABI.
 */
abiRouter.delete(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      await deleteCachedAbi(address);
      res.status(204).send();
    } catch {
      res.status(404).json({ error: 'Contract not found' });
    }
  }),
);
