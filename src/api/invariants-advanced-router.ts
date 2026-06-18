/**
 * Advanced Invariants API Endpoints
 * Mining, Fuzz Testing, Compliance, Symbolic Execution, Historical Re-Verification
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { miningEngine } from '../invariants/mining';
import { fuzzingEngine } from '../invariants/fuzz';

export const advancedInvariantsRouter = Router();

// ============================================================================
// MINING ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/invariants/mine - Start mining run
 */
advancedInvariantsRouter.post('/mine', async (req: Request, res: Response) => {
  try {
    const { contractAddress, miningType, txRangeStart, txRangeEnd } = req.body;

    if (!contractAddress || !miningType) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and miningType required',
        timestamp: new Date(),
      });
    }

    const runId = await miningEngine.startMiningRun(
      contractAddress,
      miningType,
      txRangeStart ? BigInt(txRangeStart) : undefined,
      txRangeEnd ? BigInt(txRangeEnd) : undefined,
    );

    res.status(201).json({
      success: true,
      data: { runId },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to start mining run: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Mining initialization failed',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/mine/runs - Get mining run history
 */
advancedInvariantsRouter.get('/mine/runs', async (req: Request, res: Response) => {
  try {
    const { contractAddress, limit = 50 } = req.query;

    const runs = await miningEngine.getMiningRuns(
      contractAddress as string | undefined,
      Number(limit),
    );

    res.json({
      success: true,
      data: runs,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get mining runs: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mining runs',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/mine/runs/:id - Get run details
 */
advancedInvariantsRouter.get('/mine/runs/:id', async (req: Request, res: Response) => {
  try {
    const run = await prismaRead.invariantMiningRun.findUnique({
      where: { id: req.params.id },
      include: {
        candidates: {
          orderBy: { confidence: 'desc' },
        },
      },
    });

    if (!run) {
      return res.status(404).json({
        success: false,
        error: 'Mining run not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: run,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get mining run: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mining run',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/mine/candidates/:id/confirm - Confirm candidate
 */
advancedInvariantsRouter.post('/mine/candidates/:id/confirm', async (req: Request, res: Response) => {
  try {
    await miningEngine.confirmCandidate(BigInt(req.params.id));

    res.json({
      success: true,
      message: 'Candidate confirmed and converted to invariant',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to confirm candidate: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Confirmation failed',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/mine/candidates/:id/reject - Reject candidate
 */
advancedInvariantsRouter.post('/mine/candidates/:id/reject', async (req: Request, res: Response) => {
  try {
    await miningEngine.rejectCandidate(BigInt(req.params.id));

    res.json({
      success: true,
      message: 'Candidate rejected',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to reject candidate: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Rejection failed',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// FUZZ TESTING ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/invariants/fuzz - Start fuzz campaign
 */
advancedInvariantsRouter.post('/fuzz', async (req: Request, res: Response) => {
  try {
    const { contractAddress, totalIterations, invariantIds, name } = req.body;

    if (!contractAddress || !totalIterations) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and totalIterations required',
        timestamp: new Date(),
      });
    }

    const campaignId = await fuzzingEngine.startFuzzCampaign(
      contractAddress,
      totalIterations,
      invariantIds,
      name,
    );

    res.status(201).json({
      success: true,
      data: { campaignId },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to start fuzz campaign: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Fuzz campaign initialization failed',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/fuzz/campaigns - List fuzz campaigns
 */
advancedInvariantsRouter.get('/fuzz/campaigns', async (req: Request, res: Response) => {
  try {
    const { contractAddress, status, page = 1, limit = 50 } = req.query;

    const where: any = {};
    if (contractAddress) where.contractAddress = contractAddress;
    if (status) where.status = status;

    const total = await prismaRead.fuzzCampaign.count({ where });
    const campaigns = await prismaRead.fuzzCampaign.findMany({
      where,
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: campaigns,
      total,
      page: Number(page),
      limit: Number(limit),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list fuzz campaigns: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list campaigns',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/fuzz/campaigns/:id - Get campaign details
 */
advancedInvariantsRouter.get('/fuzz/campaigns/:id', async (req: Request, res: Response) => {
  try {
    const campaign = await fuzzingEngine.getCampaignResults(req.params.id);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: campaign,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get campaign: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get campaign',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/fuzz/campaigns/:id/stop - Stop fuzz campaign
 */
advancedInvariantsRouter.post('/fuzz/campaigns/:id/stop', async (req: Request, res: Response) => {
  try {
    await fuzzingEngine.stopCampaign(req.params.id);

    res.json({
      success: true,
      message: 'Campaign stopped',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to stop campaign: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to stop campaign',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// COMPLIANCE AUDIT ENDPOINTS
// ============================================================================

/**
 * GET /api/v1/invariants/compliance/frameworks - List compliance frameworks
 */
advancedInvariantsRouter.get('/compliance/frameworks', async (req: Request, res: Response) => {
  try {
    const frameworks = await prismaRead.complianceFramework.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: frameworks,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list compliance frameworks: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list frameworks',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/compliance/audit - Start compliance audit
 */
advancedInvariantsRouter.post('/compliance/audit', async (req: Request, res: Response) => {
  try {
    const { contractAddress, frameworkId } = req.body;

    if (!contractAddress || !frameworkId) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and frameworkId required',
        timestamp: new Date(),
      });
    }

    const framework = await prismaRead.complianceFramework.findUnique({
      where: { id: frameworkId },
    });

    if (!framework) {
      return res.status(404).json({
        success: false,
        error: 'Framework not found',
        timestamp: new Date(),
      });
    }

    const rules = framework.rules as any;
    const totalRules = Array.isArray(rules) ? rules.length : Object.keys(rules).length;

    const audit = await prisma.complianceAudit.create({
      data: {
        contractAddress,
        frameworkId,
        totalRules,
        status: 'pending',
        startedAt: new Date(),
      } as any,
    });

    res.status(201).json({
      success: true,
      data: audit,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to start audit: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Audit initialization failed',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/compliance/audits - List audits
 */
advancedInvariantsRouter.get('/compliance/audits', async (req: Request, res: Response) => {
  try {
    const { contractAddress, status, page = 1, limit = 50 } = req.query;

    const where: any = {};
    if (contractAddress) where.contractAddress = contractAddress;
    if (status) where.status = status;

    const total = await prismaRead.complianceAudit.count({ where });
    const audits = await prismaRead.complianceAudit.findMany({
      where,
      include: { framework: true },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: audits,
      total,
      page: Number(page),
      limit: Number(limit),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list audits: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list audits',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/compliance/audits/:id - Get audit report
 */
advancedInvariantsRouter.get('/compliance/audits/:id', async (req: Request, res: Response) => {
  try {
    const audit = await prismaRead.complianceAudit.findUnique({
      where: { id: req.params.id },
      include: { framework: true },
    });

    if (!audit) {
      return res.status(404).json({
        success: false,
        error: 'Audit not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: audit,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get audit: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get audit',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// HISTORICAL RE-VERIFICATION ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/invariants/reverify - Start re-verification job
 */
advancedInvariantsRouter.post('/reverify', async (req: Request, res: Response) => {
  try {
    const { invariantId, blockRangeStart, blockRangeEnd } = req.body;

    if (!invariantId) {
      return res.status(400).json({
        success: false,
        error: 'invariantId required',
        timestamp: new Date(),
      });
    }

    const job = await prisma.reverifyJob.create({
      data: {
        invariantId,
        blockRangeStart: blockRangeStart ? BigInt(blockRangeStart) : undefined,
        blockRangeEnd: blockRangeEnd ? BigInt(blockRangeEnd) : undefined,
        totalBlocks: blockRangeEnd && blockRangeStart ? BigInt(blockRangeEnd - blockRangeStart) : undefined,
        status: 'running',
      } as any,
    });

    res.status(201).json({
      success: true,
      data: { jobId: job.id },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to start reverify job: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Re-verification initialization failed',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/reverify/jobs - List re-verification jobs
 */
advancedInvariantsRouter.get('/reverify/jobs', async (req: Request, res: Response) => {
  try {
    const { invariantId, status, page = 1, limit = 50 } = req.query;

    const where: any = {};
    if (invariantId) where.invariantId = invariantId;
    if (status) where.status = status;

    const total = await prismaRead.reverifyJob.count({ where });
    const jobs = await prismaRead.reverifyJob.findMany({
      where,
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { startedAt: 'desc' },
    });

    res.json({
      success: true,
      data: jobs,
      total,
      page: Number(page),
      limit: Number(limit),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list reverify jobs: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list jobs',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/reverify/jobs/:id - Get job details
 */
advancedInvariantsRouter.get('/reverify/jobs/:id', async (req: Request, res: Response) => {
  try {
    const job = await prismaRead.reverifyJob.findUnique({
      where: { id: req.params.id },
      include: { invariant: true },
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: job,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get job: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get job',
      timestamp: new Date(),
    });
  }
});

export default advancedInvariantsRouter;
