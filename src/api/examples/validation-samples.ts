/**
 * Sample: Validation Middleware Usage Patterns
 *
 * This file demonstrates best practices for using Zod validation middleware
 * across your Express routes. Copy these patterns to your own route handlers.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  validateQuery,
  validateBody,
  validateParams,
  validateQueryAndBody,
} from '../middleware/validation';
import {
  paginationSchema,
  listQuerySchema,
  cursorListSchema,
  contractFilterSchema,
  updateMetadataSchema,
  txStatusFilterSchema,
  stellarAddress,
  safeLabel,
  safeRecord,
} from '../schemas/common';
import { z } from 'zod';
import { prismaRead as prisma } from '../db';

export const sampleValidationRouter = Router();

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 1: Simple query validation (GET list endpoint)
// ──────────────────────────────────────────────────────────────────────────────

// Middleware chain: validate query → handler
sampleValidationRouter.get(
  '/items',
  validateQuery(listQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    // Access validated query from middleware
    const query = (req as any).validatedQuery as z.infer<typeof listQuerySchema>;

    const skip = (query.page - 1) * query.limit;

    // Your query logic here
    res.json({
      data: [],
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 2: Query + params validation (GET with path parameter + filters)
// ──────────────────────────────────────────────────────────────────────────────

// Define a schema for path params
const getItemParamsSchema = z.object({
  id: z.string().uuid(),
});

sampleValidationRouter.get(
  '/items/:id',
  validateParams(getItemParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = (req as any).validatedParams as z.infer<typeof getItemParamsSchema>;

    // Retrieve the item using params.id
    res.json({ id: params.id, name: 'Item name' });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 3: Body validation (POST/PUT)
// ──────────────────────────────────────────────────────────────────────────────

const createItemSchema = z.object({
  name: safeLabel,
  description: z.string().optional(),
  metadata: safeRecord.optional(),
});

sampleValidationRouter.post(
  '/items',
  validateBody(createItemSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as any).validatedBody as z.infer<typeof createItemSchema>;

    // All fields are guaranteed to pass the schema
    res.status(201).json({ id: 'new-id', ...body });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 4: Query + Body validation (POST with filters + data)
// ──────────────────────────────────────────────────────────────────────────────

const batchCreateQuerySchema = z.object({
  dryRun: z.coerce.boolean().default(false),
  notifyEmail: z.string().email().optional(),
});

const batchCreateBodySchema = z.object({
  items: z.array(createItemSchema).min(1).max(100),
});

sampleValidationRouter.post(
  '/items/batch',
  validateQueryAndBody(batchCreateQuerySchema, batchCreateBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof batchCreateQuerySchema>;
    const body = (req as any).validatedBody as z.infer<typeof batchCreateBodySchema>;

    if (query.dryRun) {
      return res.json({ mode: 'dryRun', count: body.items.length });
    }

    res.status(201).json({
      created: body.items.length,
      notifyEmail: query.notifyEmail,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 5: Cursor-based pagination with filters
// ──────────────────────────────────────────────────────────────────────────────

sampleValidationRouter.get(
  '/contracts',
  validateQuery(cursorListSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof cursorListSchema>;

    // Build WHERE clause from filters
    const where = {
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { address: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
    };

    // Cursor pagination logic
    let results;
    if (query.cursor) {
      results = await prisma.contract.findMany({
        where,
        orderBy: { id: query.sortOrder === 'asc' ? 'asc' : 'desc' },
        skip: 1, // Skip the cursor itself
        take: query.limit,
        cursor: { id: query.cursor.toString() },
      });
    } else {
      results = await prisma.contract.findMany({
        where,
        orderBy: { id: query.sortOrder === 'asc' ? 'asc' : 'desc' },
        take: query.limit,
      });
    }

    const nextCursor = results.length === query.limit ? results[results.length - 1].id : null;

    res.json({
      data: results,
      cursor: nextCursor,
      hasMore: results.length === query.limit,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 6: Address-based filter validation
// ──────────────────────────────────────────────────────────────────────────────

sampleValidationRouter.get(
  '/wallet/:address/transactions',
  validateParams(z.object({ address: stellarAddress })),
  validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })),
  asyncHandler(async (req: Request, res: Response) => {
    const params = (req as any).validatedParams as { address: string };
    const query = (req as any).validatedQuery as { limit: number };

    // Fetch transactions for the validated Stellar address
    res.json({
      address: params.address,
      transactions: [],
      limit: query.limit,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 7: Contract + transaction filters combined
// ──────────────────────────────────────────────────────────────────────────────

const txListQuerySchema = paginationSchema.merge(contractFilterSchema).merge(txStatusFilterSchema);

sampleValidationRouter.get(
  '/transactions',
  validateQuery(txListQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof txListQuerySchema>;

    const where = {
      ...(query.contract && { contractAddress: query.contract }),
      ...(query.account && { sourceAccount: query.account }),
      ...(query.status && { status: query.status }),
      ...(query.minFeeCharged && { feeCharged: { gte: query.minFeeCharged } }),
      ...(query.maxFeeCharged && { feeCharged: { lte: query.maxFeeCharged } }),
    };

    const skip = (query.page - 1) * query.limit;

    res.json({
      data: [],
      page: query.page,
      limit: query.limit,
      filters: { contract: query.contract, account: query.account, status: query.status },
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 8: Batch operation with validation
// ──────────────────────────────────────────────────────────────────────────────

const batchUpdateSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
  updates: updateMetadataSchema,
});

sampleValidationRouter.patch(
  '/items/batch',
  validateBody(batchUpdateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req as any).validatedBody as z.infer<typeof batchUpdateSchema>;

    res.json({
      updated: body.ids.length,
      changes: body.updates,
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 9: Custom validation schema inline
// ──────────────────────────────────────────────────────────────────────────────

const advancedFilterSchema = z.object({
  networks: z.array(z.enum(['testnet', 'mainnet'])).optional(),
  minTxFee: z.coerce.number().min(0).optional(),
  maxTxFee: z.coerce.number().min(0).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

sampleValidationRouter.get(
  '/advanced-search',
  validateQuery(advancedFilterSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = (req as any).validatedQuery as z.infer<typeof advancedFilterSchema>;

    res.json({
      filters: query,
      results: [],
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────────────
// PATTERN 10: Multiple param validation
// ──────────────────────────────────────────────────────────────────────────────

const multiParamSchema = z.object({
  contractAddress: stellarAddress,
  functionName: safeLabel,
});

sampleValidationRouter.get(
  '/contract/:contractAddress/function/:functionName',
  validateParams(multiParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = (req as any).validatedParams as z.infer<typeof multiParamSchema>;

    res.json({
      contract: params.contractAddress,
      function: params.functionName,
    });
  }),
);
