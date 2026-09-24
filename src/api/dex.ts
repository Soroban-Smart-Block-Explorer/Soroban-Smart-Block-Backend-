import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyzeTransaction, analyzeRange } from '../indexer/dex-analyzer';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * @swagger
 * tags:
 *   name: DEX Analysis
 *   description: Decentralized Exchange transaction analysis and swap detection
 */

export const dexRouter = Router();

/**
 * Analyze a single DEX transaction and extract swap details.
 *
 * @route {GET} /api/v1/dex/analyze/:hash
 * @param {string} hash - Transaction hash (64 hex characters)
 * @returns {object} 200 - Swap analysis
 * @returns {string} 200.transactionHash - The analyzed transaction hash
 * @returns {string} 200.dexName - Detected DEX protocol name
 * @returns {string} 200.swapType - Type of swap (pool_swap, aggregator, etc.)
 * @returns {Array} 200.swaps - Array of swap operations
 * @returns {string} 200.swaps[].tokenIn - Input token address
 * @returns {number} 200.swaps[].amountIn - Amount of input token (in smallest units)
 * @returns {string} 200.swaps[].tokenOut - Output token address
 * @returns {number} 200.swaps[].amountOut - Amount of output token (in smallest units)
 * @returns {number} 200.swaps[].priceImpact - Price impact percentage
 * @returns {object} 404 - Transaction not found
 * @returns {string} 404.error - "Transaction not found"
 * @example
 * // Request
 * GET /api/v1/dex/analyze/0x1234567890abcdef...
 *
 * // Response (200)
 * {
 *   "transactionHash": "0x1234...",
 *   "dexName": "StellarSwap",
 *   "swapType": "pool_swap",
 *   "swaps": [
 *     {
 *       "tokenIn": "CUSDC",
 *       "amountIn": 1000000,
 *       "tokenOut": "CXLM",
 *       "amountOut": 987000,
 *       "priceImpact": 0.13
 *     }
 *   ]
 * }
 *
 * // Response (404)
 * { "error": "Transaction not found" }
 */
dexRouter.get(
  '/analyze/:hash',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await analyzeTransaction(req.params.hash);
    if (!result) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result);
  }),
);

const rangeSchema = z.object({
  ledgerMin: z.coerce.number().int().min(0),
  ledgerMax: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Analyze all DEX transactions within a ledger range.
 *
 * @route {GET} /api/v1/dex/analyze
 * @queryparam {number} ledgerMin - Minimum ledger sequence (inclusive)
 * @queryparam {number} ledgerMax - Maximum ledger sequence (inclusive)
 * @queryparam {number} [limit=100] - Maximum transactions to analyze (1-500)
 * @returns {object} 200 - Analysis results
 * @returns {Array} 200.data - Array of swap analyses
 * @returns {number} 200.count - Number of analyzed transactions
 * @returns {object} 400 - Bad request (invalid parameters or ledgerMax < ledgerMin)
 * @returns {string} 400.error - Error message
 * @example
 * // Request
 * GET /api/v1/dex/analyze?ledgerMin=1000&ledgerMax=2000&limit=50
 *
 * // Response (200)
 * {
 *   "data": [
 *     { "transactionHash": "...", "dexName": "StellarSwap", ... },
 *     { "transactionHash": "...", "dexName": "DeFi-Protocol", ... }
 *   ],
 *   "count": 2
 * }
 *
 * // Response (400)
 * { "error": "ledgerMax must be >= ledgerMin" }
 */
dexRouter.get(
  '/analyze',
  asyncHandler(async (req: Request, res: Response) => {
    const { ledgerMin, ledgerMax, limit } = rangeSchema.parse(req.query);
    if (ledgerMax < ledgerMin) {
      return res.status(400).json({ error: 'ledgerMax must be >= ledgerMin' });
    }
    const results = await analyzeRange(ledgerMin, ledgerMax, limit);
    res.json({ data: results, count: results.length });
  }),
);
