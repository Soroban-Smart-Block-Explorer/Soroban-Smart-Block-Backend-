import { Router, Request, Response } from 'express';
import { prismaRead } from '../db';
import { validateAddressParam } from '../middleware/sanitize';

export const healthRouter = Router();

// GET /emergency/protocol-health
healthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const scores = await prismaRead.protocolHealthScore.findMany({
      orderBy: { healthScore: 'desc' },
    });

    const sorted = scores.map((s) => ({
      name: s.protocolName ?? s.contractAddress,
      address: s.contractAddress,
      healthScore: Number(s.healthScore ?? 0),
      riskLevel: s.riskLevel ?? 'unknown',
      recoveryScore: Number(s.recoveryScore ?? 0),
      decentralizationScore: Number(s.decentralizationScore ?? 0),
      totalPauses30d: s.totalPauses30d,
      computedAt: s.computedAt,
    }));

    const byHealth = [...sorted].sort((a, b) => b.healthScore - a.healthScore);
    const byRecovery = [...sorted].sort((a, b) => b.recoveryScore - a.recoveryScore);
    const byDecentralization = [...sorted].sort(
      (a, b) => b.decentralizationScore - a.decentralizationScore,
    );

    res.json({
      protocols: sorted,
      rankings: {
        mostReliable: byHealth.slice(0, 5).map((s) => s.name),
        bestRecovery: byRecovery.slice(0, 5).map((s) => s.name),
        mostDecentralized: byDecentralization.slice(0, 5).map((s) => s.name),
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/protocol-health/:address
healthRouter.get('/:address', validateAddressParam, async (req: Request, res: Response) => {
  try {
    const score = await prismaRead.protocolHealthScore.findUnique({
      where: { contractAddress: req.params.address },
    });
    if (!score)
      return res.status(404).json({ error: 'No health score available for this contract.' });
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
