import { Router, Request, Response } from 'express';
import { prismaRead } from '../db';

export const vizRouter = Router();

// GET /emergency/visualizations/pause-timeline — Gantt chart data
vizRouter.get('/pause-timeline', async (_req: Request, res: Response) => {
  try {
    const events = await prismaRead.pauseEvent.findMany({
      orderBy: { timestamp: 'asc' },
      take: 500,
    });

    const contracts = new Set(events.map((e) => e.contractAddress));
    const contractNames = await prismaRead.contract.findMany({
      where: { address: { in: [...contracts] } },
      select: { address: true, name: true },
    });
    const nameMap = Object.fromEntries(contractNames.map((c) => [c.address, c.name]));

    // Build Gantt rows: pair each pause with the following unpause
    const byContract: Record<string, typeof events> = {};
    for (const ev of events) {
      (byContract[ev.contractAddress] ??= []).push(ev);
    }

    const gantt: Array<{ contract: string; name: string | null; segments: Array<{ start: Date; end: Date | null; durationSeconds: number | null }> }> = [];

    for (const [addr, evs] of Object.entries(byContract)) {
      const segments: Array<{ start: Date; end: Date | null; durationSeconds: number | null }> = [];
      for (const ev of evs) {
        if (ev.eventType === 'pause') {
          segments.push({ start: ev.timestamp, end: null, durationSeconds: null });
        } else if (ev.eventType === 'unpause' && segments.length > 0) {
          const last = segments[segments.length - 1];
          if (!last.end) {
            last.end = ev.timestamp;
            last.durationSeconds = Number(ev.durationSeconds ?? 0);
          }
        }
      }
      gantt.push({ contract: addr, name: nameMap[addr] ?? null, segments });
    }

    res.json({ gantt });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/visualizations/health-comparison — radar chart data
vizRouter.get('/health-comparison', async (_req: Request, res: Response) => {
  try {
    const scores = await prismaRead.protocolHealthScore.findMany({
      orderBy: { healthScore: 'desc' },
      take: 20,
    });

    const radarData = scores.map((s) => ({
      name: s.protocolName ?? s.contractAddress,
      address: s.contractAddress,
      axes: {
        reliability: Math.max(0, 100 - s.totalPauses30d * 10),
        recovery: Number(s.recoveryScore ?? 0),
        decentralization: Number(s.decentralizationScore ?? 0),
        overall: Number(s.healthScore ?? 0),
      },
    }));

    res.json({ radarData });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/visualizations/risk-matrix — decentralization x recovery
vizRouter.get('/risk-matrix', async (_req: Request, res: Response) => {
  try {
    const scores = await prismaRead.protocolHealthScore.findMany({
      select: {
        contractAddress: true,
        protocolName: true,
        decentralizationScore: true,
        recoveryScore: true,
        riskLevel: true,
        healthScore: true,
      },
    });

    const matrix = scores.map((s) => ({
      name: s.protocolName ?? s.contractAddress,
      address: s.contractAddress,
      x: Number(s.decentralizationScore ?? 0), // decentralization axis
      y: Number(s.recoveryScore ?? 0),          // recovery axis
      riskLevel: s.riskLevel,
      healthScore: Number(s.healthScore ?? 0),
    }));

    res.json({ matrix });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/visualizations/downtime-distribution
vizRouter.get('/downtime-distribution', async (_req: Request, res: Response) => {
  try {
    const byContract = await prismaRead.pauseEvent.groupBy({
      by: ['contractAddress'],
      _sum: { durationSeconds: true },
      _count: { id: true },
      where: { eventType: 'pause' },
      orderBy: { _sum: { durationSeconds: 'desc' } },
      take: 30,
    });

    const addresses = byContract.map((b) => b.contractAddress);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: addresses } },
      select: { address: true, name: true },
    });
    const nameMap = Object.fromEntries(contracts.map((c) => [c.address, c.name]));

    const distribution = byContract.map((b) => ({
      name: nameMap[b.contractAddress] ?? b.contractAddress,
      address: b.contractAddress,
      totalDowntimeSeconds: Number(b._sum.durationSeconds ?? 0),
      pauseCount: b._count.id,
    }));

    res.json({ distribution });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/export/csv
vizRouter.get('/export/csv', async (_req: Request, res: Response) => {
  try {
    const events = await prismaRead.pauseEvent.findMany({
      orderBy: { timestamp: 'desc' },
      take: 10000,
    });

    const header = 'id,contractAddress,eventType,pauserAddress,reason,txHash,blockNumber,timestamp,durationSeconds\n';
    const rows = events.map((e) =>
      [e.id, e.contractAddress, e.eventType, e.pauserAddress ?? '', (e.reason ?? '').replace(/,/g, ';'), e.txHash, e.blockNumber, e.timestamp.toISOString(), e.durationSeconds ?? ''].join(','),
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="emergency-events.csv"');
    res.send(header + rows.join('\n'));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
