import { Router, Request, Response } from 'express';
import {
  buildIntelligenceReport,
  findSimilarContracts,
} from '../intelligence/intelligence-service';

export const intelligenceRouter = Router({ mergeParams: true });

/**
 * GET /contracts/:address/intelligence
 * Comprehensive intelligence report
 */
intelligenceRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const useLlm = req.query.llm !== 'false';
    try {
      const report = await buildIntelligenceReport(address, useLlm);
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);

/**
 * GET /contracts/:address/intelligence/description
 */
intelligenceRouter.get(
  '/description',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const report = await buildIntelligenceReport(address, true);
      const description = report.llm?.description ?? report.classification.description;
      res.json({
        address,
        description,
        source: report.llm ? report.llm.provider : 'heuristic',
        confidence: report.classification.confidence,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);

/**
 * GET /contracts/:address/intelligence/category
 */
intelligenceRouter.get(
  '/category',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const report = await buildIntelligenceReport(address, false);
      res.json({
        address,
        category: report.classification.category,
        confidence: report.classification.confidence,
        protocols: report.classification.protocols,
        matchedPatterns: report.classification.matchedPatterns,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);

/**
 * GET /contracts/:address/intelligence/similar
 */
intelligenceRouter.get(
  '/similar',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const report = await buildIntelligenceReport(address, false);
      const myFunctions = report.analysis?.rawFunctionNames ?? [];
      const similarContracts = await findSimilarContracts(address, myFunctions);
      res.json({ address, similarContracts });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);

/**
 * GET /contracts/:address/intelligence/anomalies
 */
intelligenceRouter.get(
  '/anomalies',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const report = await buildIntelligenceReport(address, false);
      res.json(report.anomalies);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }),
);
