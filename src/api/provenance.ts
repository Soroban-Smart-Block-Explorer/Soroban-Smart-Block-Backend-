/**
 * Build and bytecode provenance endpoints (VE06).
 *   POST /provenance/:address         attest a build (admin)
 *   GET  /provenance/:address         attestation history
 *   GET  /provenance/:address/verify  build-compare against on-chain wasm hash
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { adminAuth } from '../middleware/adminAuth';
import { asyncHandler } from '../middleware/asyncHandler';
import { validateAddressParam } from '../middleware/sanitize';
import { attest, getHistory, verifyProvenance } from '../verification/provenance';

export const provenanceRouter = Router();

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64-char hex sha256');

const attestSchema = z.object({
  repoUrl: z.string().url().max(500),
  commitSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
  buildHash: hex64,
  artifactHash: hex64,
  toolchain: z.string().min(1).max(100).default('soroban-cli'),
});

provenanceRouter.post(
  '/:address',
  adminAuth,
  validateAddressParam,
  (req: Request, res: Response) => {
    const body = attestSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.flatten() });
    const record = attest({
      ...body.data,
      contractAddress: req.params.address,
      attestedBy: req.actor ?? 'admin',
    });
    res.status(201).json(record);
  },
);

provenanceRouter.get('/:address', validateAddressParam, (req: Request, res: Response) => {
  const history = getHistory(req.params.address);
  if (!history.length) return res.status(404).json({ error: 'No provenance recorded' });
  res.json({ contractAddress: req.params.address, latest: history[0], history });
});

provenanceRouter.get(
  '/:address/verify',
  validateAddressParam,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await verifyProvenance(req.params.address));
  }),
);
