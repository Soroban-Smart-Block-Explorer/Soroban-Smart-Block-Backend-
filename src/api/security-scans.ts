/**
 * Security scan report API (VE10)
 *
 *   GET  /security-scans          run history (summaries)
 *   GET  /security-scans/latest   latest run with change-aware diff
 *   GET  /security-scans/:id      a specific run
 *   POST /security-scans/run      trigger a scan (admin)
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../auth/middleware';
import { getScanRun, listScanRuns, runSecurityScan } from '../scheduler/security-scan';

export const securityScansRouter = Router();

securityScansRouter.get('/', (_req: Request, res: Response) => {
  const items = listScanRuns().map((r) => ({
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    contractsScanned: r.contractsScanned,
    findings: r.findings.length,
    new: r.diff.new.length,
    resolved: r.diff.resolved.length,
    analyzerErrors: r.analyzerErrors.length,
  }));
  res.json({ items, total: items.length });
});

securityScansRouter.get('/latest', (_req: Request, res: Response) => {
  const run = listScanRuns()[0];
  if (!run) return res.status(404).json({ error: 'No scans have run yet' });
  res.json(run);
});

securityScansRouter.post('/run', requireRole('admin'), async (_req: Request, res: Response) => {
  const run = await runSecurityScan();
  if (!run) return res.status(409).json({ error: 'A scan is already running' });
  res.status(201).json(run);
});

securityScansRouter.get('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const run = Number.isInteger(id) ? getScanRun(id) : undefined;
  if (!run) return res.status(404).json({ error: 'Scan not found' });
  res.json(run);
});
