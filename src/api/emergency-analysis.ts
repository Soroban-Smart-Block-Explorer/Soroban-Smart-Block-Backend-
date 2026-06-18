import { Router, Request, Response } from 'express';
import { prismaRead } from '../db';

export const analysisRouter = Router();

// GET /emergency/analysis/pause-timing
analysisRouter.get('/pause-timing', async (_req: Request, res: Response) => {
  try {
    const events = await prismaRead.pauseEvent.findMany({
      where: { eventType: 'pause' },
      select: { timestamp: true },
    });

    const byHour: Record<string, number> = {};
    const byDow: Record<string, number> = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
    const dowKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    for (const ev of events) {
      const h = ev.timestamp.getUTCHours().toString();
      byHour[h] = (byHour[h] ?? 0) + 1;
      byDow[dowKeys[ev.timestamp.getUTCDay()]]++;
    }

    res.json({ byHour, byDayOfWeek: byDow, totalEvents: events.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/analysis/pauser-behavior
analysisRouter.get('/pauser-behavior', async (_req: Request, res: Response) => {
  try {
    const events = await prismaRead.pauseEvent.findMany({
      where: { eventType: 'pause', pauserAddress: { not: null } },
      select: { pauserAddress: true, contractAddress: true, durationSeconds: true },
    });

    const pauserMap: Record<string, { count: number; contracts: Set<string>; totalDuration: bigint }> = {};
    for (const ev of events) {
      const addr = ev.pauserAddress!;
      if (!pauserMap[addr]) pauserMap[addr] = { count: 0, contracts: new Set(), totalDuration: 0n };
      pauserMap[addr].count++;
      pauserMap[addr].contracts.add(ev.contractAddress);
      pauserMap[addr].totalDuration += BigInt(ev.durationSeconds ?? 0);
    }

    const topPausers = Object.entries(pauserMap)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 20)
      .map(([address, data]) => ({
        address,
        totalPauses: data.count,
        uniqueContracts: data.contracts.size,
        avgPauseDurationSeconds: data.count > 0 ? Number(data.totalDuration) / data.count : 0,
      }));

    // Pauser overlap: find pausers that share contracts
    const overlap: Array<{ addresses: string[]; sharedContracts: number }> = [];
    const pauserList = topPausers.slice(0, 10);
    for (let i = 0; i < pauserList.length; i++) {
      for (let j = i + 1; j < pauserList.length; j++) {
        const a = pauserMap[pauserList[i].address].contracts;
        const b = pauserMap[pauserList[j].address].contracts;
        const shared = [...a].filter((c) => b.has(c)).length;
        if (shared > 0) {
          overlap.push({ addresses: [pauserList[i].address, pauserList[j].address], sharedContracts: shared });
        }
      }
    }

    res.json({ topPausers, pauserOverlap: overlap });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/analysis/contract-correlation
analysisRouter.get('/contract-correlation', async (_req: Request, res: Response) => {
  try {
    // Find contracts that paused within 5 minutes of each other
    const events = await prismaRead.pauseEvent.findMany({
      where: { eventType: 'pause' },
      orderBy: { timestamp: 'asc' },
      select: { contractAddress: true, timestamp: true, txHash: true },
    });

    const WINDOW_MS = 5 * 60_000;
    const clusters: Array<{ timestamp: Date; contracts: string[]; count: number }> = [];

    for (let i = 0; i < events.length; i++) {
      const group = [events[i].contractAddress];
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].timestamp.getTime() - events[i].timestamp.getTime() > WINDOW_MS) break;
        if (!group.includes(events[j].contractAddress)) group.push(events[j].contractAddress);
      }
      if (group.length > 1) {
        clusters.push({ timestamp: events[i].timestamp, contracts: group, count: group.length });
      }
    }

    res.json({ correlatedClusters: clusters.slice(0, 50), total: clusters.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/reports/weekly
analysisRouter.get('/reports/weekly', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 7 * 86400_000);
    const [events, newIncidents, resolvedIncidents] = await Promise.all([
      prismaRead.pauseEvent.findMany({
        where: { timestamp: { gte: since } },
        orderBy: { timestamp: 'desc' },
      }),
      prismaRead.incidentReport.count({ where: { createdAt: { gte: since } } }),
      prismaRead.incidentReport.count({ where: { resolvedAt: { gte: since } } }),
    ]);

    const pauseEvents = events.filter((e) => e.eventType === 'pause');
    const contracts = new Set(pauseEvents.map((e) => e.contractAddress));
    const totalDowntime = pauseEvents.reduce((sum, e) => sum + Number(e.durationSeconds ?? 0), 0);

    res.json({
      period: { from: since, to: new Date() },
      summary: {
        totalPauses: pauseEvents.length,
        affectedContracts: contracts.size,
        totalDowntimeSeconds: totalDowntime,
        newIncidents,
        resolvedIncidents,
      },
      events: events.slice(0, 50),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/reports/monthly/:year/:month
analysisRouter.get('/reports/monthly/:year/:month', async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Invalid year/month' });
    }

    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);

    const [events, incidents, healthScores] = await Promise.all([
      prismaRead.pauseEvent.findMany({
        where: { timestamp: { gte: from, lt: to } },
        orderBy: { timestamp: 'desc' },
      }),
      prismaRead.incidentReport.findMany({
        where: { createdAt: { gte: from, lt: to } },
        select: { severity: true, status: true, contractAddress: true },
      }),
      prismaRead.protocolHealthScore.findMany({
        orderBy: { healthScore: 'asc' },
        take: 10,
        select: { contractAddress: true, protocolName: true, healthScore: true, riskLevel: true },
      }),
    ]);

    const pauses = events.filter((e) => e.eventType === 'pause');
    const totalDowntime = pauses.reduce((sum, e) => sum + Number(e.durationSeconds ?? 0), 0);

    res.json({
      period: { year, month, from, to },
      summary: {
        totalPauses: pauses.length,
        affectedContracts: new Set(pauses.map((e) => e.contractAddress)).size,
        totalDowntimeSeconds: totalDowntime,
        incidents: incidents.length,
        criticalIncidents: incidents.filter((i) => i.severity === 'critical').length,
      },
      topRiskProtocols: healthScores,
      events: events.slice(0, 100),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
