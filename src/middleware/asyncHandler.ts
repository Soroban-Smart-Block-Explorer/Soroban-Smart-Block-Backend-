import { Request, Response, NextFunction } from 'express';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/**
 * Wraps an async Express route handler so that any rejected promise (or thrown
 * error) is automatically forwarded to the next error-handling middleware.
 *
 * Without this wrapper every async handler needs its own try/catch:
 * ```ts
 * router.get('/foo', async (req, res, next) => {
 *   try {
 *     const data = await fetchData();
 *     res.json(data);
 *   } catch (err) {
 *     next(err); // easy to forget
 *   }
 * });
 * ```
 *
 * With asyncHandler the boilerplate disappears:
 * ```ts
 * router.get('/foo', asyncHandler(async (req, res) => {
 *   const data = await fetchData();
 *   res.json(data);
 * }));
 * ```
 *
 * @param fn - The async route handler to wrap.
 * @returns A standard Express `RequestHandler` that catches errors and calls `next`.
 */
export const asyncHandler =
  (fn: AsyncRouteHandler) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
