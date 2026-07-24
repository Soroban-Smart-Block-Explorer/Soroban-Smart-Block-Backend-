import { Router, Request, Response } from 'express';
import { prisma } from '../db';

export const propagationRouter = Router();

// GET /contracts/:address/impact
propagationRouter.get('/contracts/:address/impact', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const analyses = await prisma.propagationAnalysis.findMany({
      where: { vulnerableContract: address },
      include: {
        advisory: {
          select: { severity: true, title: true, description: true },
        },
      },
      orderBy: { analyzedAt: 'desc' },
    });

    const result = analyses.map((a) => ({
      id: a.id,
      vulnerableContract: a.vulnerableContract,
      directAffected: a.directAffected,
      affectedByDepth: a.affectedByDepth,
      totalValueAtRisk: a.totalValueAtRisk ? Number(a.totalValueAtRisk) : null,
      analysisDepth: a.analysisDepth,
      analyzedAt: a.analyzedAt,
      advisory: a.advisory,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /analyze-propagation/:advisoryId
propagationRouter.get('/analyze-propagation/:advisoryId', async (req: Request, res: Response) => {
  try {
    const { advisoryId } = req.params;

    const analysis = await prisma.propagationAnalysis.findMany({
      where: { advisoryId },
      include: {
        advisory: {
          select: { severity: true, title: true, description: true },
        },
      },
      orderBy: { analyzedAt: 'desc' },
    });

    const result = analysis.map((a) => ({
      id: a.id,
      vulnerableContract: a.vulnerableContract,
      directAffected: a.directAffected,
      affectedByDepth: a.affectedByDepth,
      totalValueAtRisk: a.totalValueAtRisk ? Number(a.totalValueAtRisk) : null,
      analysisDepth: a.analysisDepth,
      analyzedAt: a.analyzedAt,
      advisory: a.advisory,
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
