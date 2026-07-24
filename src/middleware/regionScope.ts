import { Request, Response, NextFunction } from 'express';
import { resolveJurisdiction, type RegionInfo } from '../regions/topology';

/**
 * Resolves the `?region=` query parameter into a data-sovereignty filter
 * (Issue #556: "query API with `?region=eu` parameter that restricts
 * results to EU-housed data only").
 *
 * Attaches `req.regionScope` when a valid jurisdiction is requested so
 * downstream Prisma queries can add a `WHERE jurisdiction = :scope` clause.
 * No parameter means "no restriction" (query across all locally-visible
 * data), which is the existing default behavior.
 *
 * Responds 400 on an unrecognized `region` value rather than silently
 * ignoring it — a compliance filter that fails open is worse than one that
 * fails loud.
 */
export function regionScope(req: Request, res: Response, next: NextFunction): void {
  const raw = req.query.region;
  if (raw === undefined) {
    return next();
  }
  if (typeof raw !== 'string') {
    res.status(400).json({ error: 'region query parameter must be a single string value' });
    return;
  }
  const jurisdiction = resolveJurisdiction(raw);
  if (!jurisdiction) {
    res.status(400).json({ error: `Unknown region "${raw}". Valid values: eu, us, apac, sa, af` });
    return;
  }
  req.regionScope = jurisdiction;
  next();
}

export type { RegionInfo };
