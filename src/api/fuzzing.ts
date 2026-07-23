import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { startFuzzJob, getFuzzJob, fuzzContract } from '../fuzzing/fuzzer';

export const fuzzingRouter = Router({ mergeParams: true });

const fuzzStartSchema = z.object({
  maxCases: z.number().int().min(1).max(500).default(50),
  targetFunctions: z.array(z.string()).optional(),
  async: z.boolean().default(true),
});

/**
 * POST /contracts/:address/fuzz/start
 * Kick off a fuzzing job (async by default)
 */
fuzzingRouter.post(
  '/start',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const parsed = fuzzStartSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { maxCases, targetFunctions, async: isAsync } = parsed.data;

    if (isAsync) {
      const jobId = startFuzzJob(address, { maxCases, targetFunctions });
      return res.status(202).json({
        jobId,
        status: 'running',
        message: `Fuzzing started. Poll GET /contracts/${address}/fuzz/report/${jobId}`,
      });
    }

    // Synchronous mode
    try {
      const report = await fuzzContract(address, { maxCases, targetFunctions });
      return res.json(report);
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }),
);

/**
 * GET /contracts/:address/fuzz/report/:jobId
 * Get fuzzing report for a specific job
 */
fuzzingRouter.get('/report/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = getFuzzJob(jobId);
  if (!job) return res.status(404).json({ error: 'Fuzz job not found' });

  if (job.status === 'running') {
    return res.status(202).json({ jobId, status: 'running', startedAt: job.startedAt });
  }
  if (job.status === 'failed') {
    return res.status(500).json({ jobId, status: 'failed', error: job.error });
  }
  return res.json({ jobId, status: 'completed', report: job.report });
});

/**
 * GET /contracts/:address/fuzz/report
 * Synchronous quick report (max 10 cases, fast)
 */
fuzzingRouter.get(
  '/report',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const report = await fuzzContract(address, { maxCases: 10 });
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);
