import { Router, Request, Response } from 'express';
import { prismaRead } from '../db';
import { z } from 'zod';
import { validateAddressParam } from '../middleware/sanitize';
import { classifyRisk, computeDecentralizationScore } from '../indexer/emergency-indexer';

export const emergencyRouter = Router();

function formatDuration(seconds: bigint | number | null): string {
  if (!seconds) return '0s';
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// GET /emergency/overview
emergencyRouter.get('/overview', async (_req: Request, res: Response) => {
  try {
    const [pausedStates, total24h, totalEvents, activeIncidents, criticalIncidents] =
      await Promise.all([
        prismaRead.emergencyState.findMany({
          where: { isPaused: true },
        }),
        prismaRead.pauseEvent.count({
          where: {
            eventType: 'pause',
            timestamp: { gte: new Date(Date.now() - 86400_000) },
          },
        }),
        prismaRead.pauseEvent.count(),
        prismaRead.incidentReport.count({ where: { status: { in: ['open', 'investigating'] } } }),
        prismaRead.incidentReport.count({ where: { severity: 'critical', status: { in: ['open', 'investigating'] } } }),
      ]);

    const contractAddresses = pausedStates.map((s) => s.contractAddress);
    const [contracts, currentPauseEvents] = await Promise.all([
      prismaRead.contract.findMany({
        where: { address: { in: contractAddresses } },
        select: { address: true, name: true },
      }),
      prismaRead.pauseEvent.findMany({
        where: {
          contractAddress: { in: contractAddresses },
          eventType: 'pause',
          id: { in: pausedStates.filter((s) => s.currentPauseId).map((s) => s.currentPauseId!) },
        },
      }),
    ]);

    const contractMap = Object.fromEntries(contracts.map((c) => [c.address, c]));
    const pauseMap = Object.fromEntries(currentPauseEvents.map((e) => [e.contractAddress, e]));

    const pausedContracts = pausedStates.map((state) => {
      const pe = pauseMap[state.contractAddress];
      const durationSec = pe
        ? Math.round((Date.now() - pe.timestamp.getTime()) / 1000)
        : 0;
      return {
        contract: state.contractAddress,
        name: contractMap[state.contractAddress]?.name ?? null,
        pausedAt: pe?.timestamp ?? null,
        pauser: pe?.pauserAddress ?? null,
        duration: formatDuration(durationSec),
        reason: pe?.reason ?? null,
        severity: classifyRisk(Number(state.decentralizationScore ?? 0)),
        pauserType: state.pauserType,
        decentralizationScore: state.decentralizationScore,
      };
    });

    res.json({
      pausedContracts,
      totalPausedNow: pausedStates.length,
      totalPaused24h: total24h,
      totalHistoricalEvents: totalEvents,
      activeIncidents,
      criticalAlerts: criticalIncidents,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/contracts/:address
emergencyRouter.get('/contracts/:address', validateAddressParam, async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const [state, pauserAnalysis, recoveryAnalysis, contract, incidents] = await Promise.all([
      prismaRead.emergencyState.findUnique({ where: { contractAddress: address } }),
      prismaRead.pauserAnalysis.findUnique({ where: { contractAddress: address } }),
      prismaRead.recoveryAnalysis.findUnique({ where: { contractAddress: address } }),
      prismaRead.contract.findUnique({ where: { address }, select: { name: true } }),
      prismaRead.incidentReport.findMany({
        where: { contractAddress: address },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, createdAt: true, severity: true, status: true, title: true },
      }),
    ]);

    const pauseHistory = await prismaRead.pauseEvent.findMany({
      where: { contractAddress: address },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    let currentPause = null;
    if (state?.isPaused && state.currentPauseId) {
      const pe = pauseHistory.find((p) => p.id === state.currentPauseId);
      if (pe) {
        currentPause = {
          id: pe.id,
          startedAt: pe.timestamp,
          pauser: pe.pauserAddress,
          reason: pe.reason,
          txHash: pe.txHash,
          blockNumber: pe.blockNumber,
        };
      }
    }

    const history = pauseHistory
      .filter((p) => p.eventType === 'unpause')
      .map((p) => ({
        endedAt: p.timestamp,
        duration: formatDuration(p.durationSeconds),
        txHash: p.txHash,
      }));

    const decScore = Number(state?.decentralizationScore ?? pauserAnalysis ? 0 : 0);
    const recovScore = Number(recoveryAnalysis?.recoveryRobustnessScore ?? 0);

    res.json({
      contract: address,
      protocolName: contract?.name ?? null,
      isPaused: state?.isPaused ?? false,
      currentPause,
      pauseHistory: history,
      pauserAnalysis: pauserAnalysis
        ? {
            type: pauserAnalysis.pauserType,
            signers: pauserAnalysis.pauserAddresses,
            threshold: pauserAnalysis.threshold,
            decentralizationScore: pauserAnalysis ? computeDecScore(pauserAnalysis) : 0,
            riskLevel: classifyRisk(pauserAnalysis ? computeDecScore(pauserAnalysis) : 0),
          }
        : null,
      recoveryAnalysis: recoveryAnalysis
        ? {
            hasFundRecovery: recoveryAnalysis.hasFundRecovery,
            fundRecoveryFunctions: recoveryAnalysis.fundRecoveryFunctions,
            hasUpgradeCapability: recoveryAnalysis.hasUpgradeCapability,
            upgradeFunctions: recoveryAnalysis.upgradeFunctions,
            recoveryRobustnessScore: recovScore,
            riskLevel: classifyRisk(100 - recovScore),
          }
        : null,
      incidentHistory: incidents.map((i) => ({
        id: i.id,
        date: i.createdAt,
        severity: i.severity,
        status: i.status,
        title: i.title,
      })),
      healthScore: {
        overall: Math.round((decScore * 0.2 + recovScore * 0.3 + (100 - Math.min(100, (state?.totalPauseCount ?? 0) * 5)) * 0.4 + 70 * 0.1)),
        reliability: Math.max(0, 100 - (state?.totalPauseCount ?? 0) * 5),
        decentralization: decScore,
        recoveryPreparedness: recovScore,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function computeDecScore(pa: { pauserType: string; threshold?: number | null; totalSigners?: number | null; timelockDelaySeconds?: bigint | null }): number {
  const days = pa.timelockDelaySeconds ? Number(pa.timelockDelaySeconds) / 86400 : undefined;
  return computeDecentralizationScore(pa.pauserType, pa.threshold ?? undefined, pa.totalSigners ?? undefined, days);
}

const eventsQuerySchema = z.object({
  contract: z.string().optional(),
  type: z.enum(['pause', 'unpause']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// GET /emergency/events
emergencyRouter.get('/events', async (req: Request, res: Response) => {
  try {
    const { contract, type, page, limit } = eventsQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;
    const where: any = {
      ...(contract ? { contractAddress: contract } : {}),
      ...(type ? { eventType: type } : {}),
    };

    const [data, total] = await Promise.all([
      prismaRead.pauseEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      prismaRead.pauseEvent.count({ where }),
    ]);

    res.json({ data, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/events/:id
emergencyRouter.get('/events/:id', async (req: Request, res: Response) => {
  try {
    const ev = await prismaRead.pauseEvent.findUnique({ where: { id: req.params.id } });
    if (!ev) return res.status(404).json({ error: 'Not found' });
    res.json(ev);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/contracts/:address/events
emergencyRouter.get('/contracts/:address/events', validateAddressParam, async (req: Request, res: Response) => {
  try {
    const events = await prismaRead.pauseEvent.findMany({
      where: { contractAddress: req.params.address },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });
    res.json({ data: events, total: events.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/stats
emergencyRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [allEvents, byProtocol, byDayOfWeek] = await Promise.all([
      prismaRead.pauseEvent.aggregate({
        _count: { id: true },
        _avg: { durationSeconds: true },
        _max: { durationSeconds: true },
        _sum: { durationSeconds: true },
      }),
      prismaRead.pauseEvent.groupBy({
        by: ['contractAddress'],
        _count: { id: true },
        _sum: { durationSeconds: true },
        where: { eventType: 'pause' },
      }),
      prismaRead.pauseEvent.findMany({
        where: { eventType: 'pause' },
        select: { timestamp: true },
      }),
    ]);

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const byDay: Record<string, number> = Object.fromEntries(dayNames.map((d) => [d, 0]));
    for (const ev of byDayOfWeek) {
      byDay[dayNames[ev.timestamp.getDay()]]++;
    }

    const contractAddresses = byProtocol.map((b) => b.contractAddress);
    const contracts = await prismaRead.contract.findMany({
      where: { address: { in: contractAddresses } },
      select: { address: true, name: true },
    });
    const healthScores = await prismaRead.protocolHealthScore.findMany({
      where: { contractAddress: { in: contractAddresses } },
      select: { contractAddress: true, riskLevel: true },
    });
    const nameMap = Object.fromEntries(contracts.map((c) => [c.address, c.name]));
    const riskMap = Object.fromEntries(healthScores.map((h) => [h.contractAddress, h.riskLevel]));

    const uniqueContracts = new Set(byProtocol.map((b) => b.contractAddress)).size;

    const pauseTypes = await prismaRead.emergencyState.groupBy({
      by: ['pauserType'],
      _count: { id: true },
      where: { pauserType: { not: null } },
    });
    const byPauserType: Record<string, number> = {};
    for (const pt of pauseTypes) {
      if (pt.pauserType) byPauserType[pt.pauserType] = pt._count.id;
    }

    res.json({
      overall: {
        totalPauseEvents: allEvents._count.id,
        uniquePausedContracts: uniqueContracts,
        avgPauseDuration: formatDuration(allEvents._avg.durationSeconds ?? 0),
        longestPause: formatDuration(allEvents._max.durationSeconds ?? 0),
        totalDowntimeAllContracts: formatDuration(allEvents._sum.durationSeconds ?? 0),
      },
      byProtocol: byProtocol.map((b) => ({
        protocol: nameMap[b.contractAddress] ?? b.contractAddress,
        address: b.contractAddress,
        pauses: b._count.id,
        totalDowntime: formatDuration(b._sum.durationSeconds ?? 0),
        riskLevel: riskMap[b.contractAddress] ?? 'unknown',
      })),
      byDayOfWeek: byDay,
      byPauserType,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /emergency/contracts/:address/recovery-simulation
emergencyRouter.get('/contracts/:address/recovery-simulation', validateAddressParam, async (req: Request, res: Response) => {
  try {
    const ra = await prismaRead.recoveryAnalysis.findUnique({
      where: { contractAddress: req.params.address },
    });
    if (!ra) return res.status(404).json({ error: 'No recovery analysis found. Trigger analysis first.' });

    const paths: Array<{
      type: string;
      function: string;
      steps: string[];
      estimatedTime: string;
      complexity: string;
      riskFactors: string[];
    }> = [];

    for (const fn of ra.fundRecoveryFunctions) {
      paths.push({
        type: 'fund_recovery',
        function: fn,
        steps: [`Call ${fn}(to, token, amount)`, 'Tokens transferred to admin wallet'],
        estimatedTime: '5 minutes',
        complexity: 'low',
        riskFactors: ['May not cover all token types', 'Requires admin key'],
      });
    }
    for (const fn of ra.upgradeFunctions) {
      paths.push({
        type: 'upgrade',
        function: fn,
        steps: ['Deploy patched WASM bytecode', `Call ${fn}(new_wasm_hash)`, 'Verify new implementation'],
        estimatedTime: '30 minutes',
        complexity: 'medium',
        riskFactors: ['State compatibility required', 'New contract must be audited'],
      });
    }
    for (const fn of ra.migrationFunctions) {
      paths.push({
        type: 'migration',
        function: fn,
        steps: [`Call ${fn}()`, 'Export state to new contract', 'Redirect users'],
        estimatedTime: '1-2 hours',
        complexity: 'high',
        riskFactors: ['State migration complexity', 'Downtime during migration'],
      });
    }
    for (const fn of ra.rollbackFunctions) {
      paths.push({
        type: 'state_rollback',
        function: fn,
        steps: [`Call ${fn}(checkpoint_id)`, 'State reverted to checkpoint'],
        estimatedTime: '10 minutes',
        complexity: 'medium',
        riskFactors: ['Data loss since checkpoint', 'Requires valid checkpoint'],
      });
    }

    const recommended = paths[0]?.type ?? null;

    res.json({
      contract: req.params.address,
      recoveryPaths: paths,
      recommendedPath: recommended,
      canRecoverWithoutUpgrade: ra.hasFundRecovery || ra.hasStateRollback,
      estimatedRecoveryTime: paths[0]?.estimatedTime ?? 'unknown',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
