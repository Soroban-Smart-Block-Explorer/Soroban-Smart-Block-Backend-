import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listAnchors,
  getAnchorByAddress,
  getAnchorReviews,
  submitAnchorReview,
  registerAnchor,
  updateAnchor,
  getAnchorTransactionAnalytics,
} from '../../stellar/anchor-service';
import { requireWalletAuth, requireAdminAuth } from './middleware';
import { asyncHandler } from '../../middleware/asyncHandler';

export const anchorsRouter = Router();

const reviewSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const registerSchema = z.object({
  name: z.string().min(1),
  homeDomain: z.string().min(1),
  address: z.string().optional(),
  assets: z.array(z.string()),
  regions: z.array(z.string()).optional(),
  kycRequired: z.boolean().optional(),
  supportedSeps: z.array(z.string()).optional(),
});

// GET /api/v1/stellar/anchors
anchorsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const data = await listAnchors({
      region: req.query.region as string | undefined,
      asset: req.query.asset as string | undefined,
      sep: req.query.sep as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/stellar/anchors/register
anchorsRouter.post('/register', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);
    const anchor = await registerAnchor(body);
    res.status(201).json(anchor);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/anchors/:address
anchorsRouter.get('/:address', async (req: Request, res: Response) => {
  try {
    const anchor = await getAnchorByAddress(req.params.address);
    if (!anchor) return res.status(404).json({ error: 'Anchor not found' });
    res.json(anchor);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /api/v1/stellar/anchors/:address
anchorsRouter.put('/:address', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const anchor = await updateAnchor(req.params.address, req.body);
    res.json(anchor);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/anchors/:address/reviews
anchorsRouter.get('/:address/reviews', async (req: Request, res: Response) => {
  try {
    const data = await getAnchorReviews(req.params.address);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/stellar/anchors/:address/reviews
anchorsRouter.post('/:address/reviews', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const body = reviewSchema.parse(req.body);
    const wallet = (req as Request & { walletAddress: string }).walletAddress;
    const review = await submitAnchorReview(req.params.address, wallet, body.rating, body.comment);
    res.status(201).json(review);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/anchors/:address/transactions
anchorsRouter.get('/:address/transactions', async (req: Request, res: Response) => {
  try {
    const data = await getAnchorTransactionAnalytics(req.params.address);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/v1/stellar/anchors/:address/sep24/info
anchorsRouter.get('/:address/sep24/info', async (req: Request, res: Response) => {
  try {
    const anchor = await getAnchorByAddress(req.params.address);
    if (!anchor) return res.status(404).json({ error: 'Anchor not found' });
    const supportsSep24 = anchor.supportedSeps?.includes('SEP-24');
    res.json({
      supported: supportsSep24,
      transferServer: supportsSep24 ? `https://${anchor.homeDomain}/sep24` : null,
      kycRequired: anchor.kycRequired,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/v1/stellar/anchors/:address/sep24/deposit
anchorsRouter.post(
  '/:address/sep24/deposit',
  requireWalletAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(501).json({
      error: 'SEP-24 deposit flow requires interactive anchor integration',
      info: 'Use the anchor transfer server directly for KYC and deposit initiation',
    });
  }),
);

// POST /api/v1/stellar/anchors/:address/sep24/withdraw
anchorsRouter.post(
  '/:address/sep24/withdraw',
  requireWalletAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(501).json({
      error: 'SEP-24 withdrawal flow requires interactive anchor integration',
      info: 'Use the anchor transfer server directly for KYC and withdrawal initiation',
    });
  }),
);
