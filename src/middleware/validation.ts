/**
 * Zod-based request validation middleware factory
 *
 * Provides convenient middleware for validating query parameters, request bodies,
 * and path parameters using Zod schemas. All validators return 400 on invalid input
 * with detailed field-level error information.
 *
 * Usage:
 *   import { validateQuery, validateBody, validateParams } from '../middleware/validation';
 *   import { listQuerySchema } from '../schemas/common';
 *
 *   router.get('/items', validateQuery(listQuerySchema), (req, res) => {
 *     const params = req.query as z.infer<typeof listQuerySchema>;
 *     // ...
 *   });
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export type ValidationError = {
  error: string;
  details: Record<string, string[]>;
};

/**
 * Middleware factory for query parameter validation.
 * Assigns validated data to req.validatedQuery.
 * Returns 400 on validation failure.
 *
 * @param schema Zod schema for query validation
 * @returns Express middleware
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: result.error.flatten().fieldErrors,
      } as ValidationError);
      return;
    }

    // Store validated data in a typed property for downstream handlers
    (req as any).validatedQuery = result.data;
    next();
  };
}

/**
 * Middleware factory for request body validation.
 * Assigns validated data to req.validatedBody.
 * Returns 400 on validation failure.
 *
 * @param schema Zod schema for body validation
 * @returns Express middleware
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: result.error.flatten().fieldErrors,
      } as ValidationError);
      return;
    }

    (req as any).validatedBody = result.data;
    next();
  };
}

/**
 * Middleware factory for path parameter validation.
 * Assigns validated data to req.validatedParams.
 * Returns 400 on validation failure.
 *
 * @param schema Zod schema for params validation
 * @returns Express middleware
 */
export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      res.status(400).json({
        error: 'Invalid path parameters',
        details: result.error.flatten().fieldErrors,
      } as ValidationError);
      return;
    }

    (req as any).validatedParams = result.data;
    next();
  };
}

/**
 * Middleware factory for combined validation (query + body).
 * Assigns validated data to req.validatedQuery and req.validatedBody.
 * Returns 400 on first validation failure.
 *
 * @param querySchema Zod schema for query validation
 * @param bodySchema Zod schema for body validation
 * @returns Express middleware
 */
export function validateQueryAndBody<Q extends z.ZodTypeAny, B extends z.ZodTypeAny>(
  querySchema: Q,
  bodySchema: B,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Validate query first
    const queryResult = querySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        error: 'Invalid query parameters',
        details: queryResult.error.flatten().fieldErrors,
      } as ValidationError);
      return;
    }

    // Then validate body
    const bodyResult = bodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: bodyResult.error.flatten().fieldErrors,
      } as ValidationError);
      return;
    }

    (req as any).validatedQuery = queryResult.data;
    (req as any).validatedBody = bodyResult.data;
    next();
  };
}

/**
 * Parse a Zod schema against raw data and return typed result.
 * Useful for manual validation inside handler functions.
 *
 * @param schema Zod schema
 * @param data Raw data to validate
 * @returns Typed parse result with error handling
 */
export function safeParse<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; errors: Record<string, string[]> } {
  const result = schema.safeParse(data);

  if (!result.success) {
    return {
      ok: false,
      errors: result.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Strict parse: throws on validation failure (use in non-request contexts).
 * Useful for config validation or internal service data.
 *
 * @param schema Zod schema
 * @param data Raw data to validate
 * @returns Typed data or throws ZodError
 */
export function strictParse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}
