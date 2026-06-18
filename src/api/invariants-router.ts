/**
 * Invariants API Router
 * RESTful API endpoints for managing and checking contract invariants
 * Supports: registration, querying, checking, violations, monitoring, mining, fuzz testing, etc.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite as prisma } from '../db';
import { logger } from '../logger';
import { invariantChecker, stateExtractor, batchChecker } from '../invariants/engine';
import {
  InvariantDefinitionInput,
  InvariantCategory,
  InvariantSeverity,
  CheckFrequency,
  ContractStateSnapshot,
  StandardInvariantDTO,
} from '../invariants/types';

export const invariantsRouter = Router();

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createInvariantSchema = z.object({
  name: z.string().max(255),
  description: z.string().max(2048).optional(),
  category: z.enum(['state', 'algebraic', 'temporal', 'composability', 'access_control', 'economic']),
  contractAddress: z.string().optional(),
  expression: z.string(),
  expressionLanguage: z.string().default('expr_lang'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('critical'),
  checkFrequency: z.enum(['always', 'after_write', 'periodic', 'on_demand']).default('always'),
  gasLimit: z.bigint().optional(),
  timeoutMs: z.number().int().min(100).default(5000),
});

const updateInvariantSchema = createInvariantSchema.partial();

const monitoringConfigSchema = z.object({
  contractAddress: z.string(),
  invariantIds: z.string().uuid().array().optional(),
  checkMode: z.enum(['all', 'sample', 'critical']).default('all'),
  sampleRate: z.number().int().min(1).default(1),
  maxGasPerCheck: z.string().optional(),
  isActive: z.boolean().default(true),
});

// ============================================================================
// INVARIANT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/invariants - Register a custom invariant
 */
invariantsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = createInvariantSchema.parse(req.body);

    const invariant = await prisma.invariantDefinition.create({
      data: {
        ...data,
        createdBy: (req as any)?.user?.address || 'system',
      } as any,
    });

    res.status(201).json({
      success: true,
      data: invariant,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to create invariant: ${error}`);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid request',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants - List all invariants
 */
invariantsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { contractAddress, category, severity, isActive, page = 1, limit = 50 } = req.query;

    const where: any = {};
    if (contractAddress) where.contractAddress = contractAddress;
    if (category) where.category = category;
    if (severity) where.severity = severity;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const total = await prismaRead.invariantDefinition.count({ where });
    const invariants = await prismaRead.invariantDefinition.findMany({
      where,
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: invariants,
      total,
      page: Number(page),
      limit: Number(limit),
      hasMore: Number(page) * Number(limit) < total,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list invariants: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list invariants',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/:id - Get invariant details
 */
invariantsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const invariant = await prismaRead.invariantDefinition.findUnique({
      where: { id: req.params.id },
      include: {
        checkResults: {
          take: 100,
          orderBy: { timestamp: 'desc' },
        },
        violations: {
          take: 50,
          orderBy: { timestamp: 'desc' },
        },
      },
    });

    if (!invariant) {
      return res.status(404).json({
        success: false,
        error: 'Invariant not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: invariant,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get invariant: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get invariant',
      timestamp: new Date(),
    });
  }
});

/**
 * PUT /api/v1/invariants/:id - Update invariant
 */
invariantsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const data = updateInvariantSchema.parse(req.body);

    const invariant = await prisma.invariantDefinition.update({
      where: { id: req.params.id },
      data: {
        ...data,
        updatedAt: new Date(),
      } as any,
    });

    res.json({
      success: true,
      data: invariant,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to update invariant: ${error}`);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Update failed',
      timestamp: new Date(),
    });
  }
});

/**
 * DELETE /api/v1/invariants/:id - Deactivate invariant
 */
invariantsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.invariantDefinition.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({
      success: true,
      message: 'Invariant deactivated',
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to deactivate invariant: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to deactivate invariant',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/:id/test - Test invariant against current state
 */
invariantsRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const { contractAddress, state } = req.body;

    if (!contractAddress || !state) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and state required',
        timestamp: new Date(),
      });
    }

    const invariant = await prismaRead.invariantDefinition.findUnique({
      where: { id: req.params.id },
    });

    if (!invariant) {
      return res.status(404).json({
        success: false,
        error: 'Invariant not found',
        timestamp: new Date(),
      });
    }

    const contractState: ContractStateSnapshot = {
      contractAddress,
      blockNumber: BigInt(req.body.blockNumber || 0),
      timestamp: new Date(),
      state,
    };

    const result = await invariantChecker.checkInvariant(invariant as any, contractState, 'test-tx');

    res.json({
      success: true,
      data: {
        passed: result.passed,
        executionTimeMs: result.executionTimeMs,
        error: result.error,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to test invariant: ${error}`);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Test failed',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/batch - Batch register invariants
 */
invariantsRouter.post('/batch', async (req: Request, res: Response) => {
  try {
    const { invariants } = req.body;

    if (!Array.isArray(invariants)) {
      return res.status(400).json({
        success: false,
        error: 'invariants must be an array',
        timestamp: new Date(),
      });
    }

    const created = await prisma.invariantDefinition.createMany({
      data: invariants.map((inv: any) => ({
        ...inv,
        createdBy: (req as any)?.user?.address || 'system',
      })),
    });

    res.status(201).json({
      success: true,
      data: { created: created.count },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to batch create invariants: ${error}`);
    res.status(400).json({
      success: false,
      error: 'Batch creation failed',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// CONTRACT INVARIANTS ENDPOINTS
// ============================================================================

/**
 * GET /api/v1/invariants/contracts/:address - Get contract's invariants
 */
invariantsRouter.get('/contracts/:address', async (req: Request, res: Response) => {
  try {
    const invariants = await prismaRead.invariantDefinition.findMany({
      where: {
        contractAddress: req.params.address,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: invariants,
      total: invariants.length,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get contract invariants: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get contract invariants',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/contracts/:address/violations - Get contract violations
 */
invariantsRouter.get('/contracts/:address/violations', async (req: Request, res: Response) => {
  try {
    const { status, severity, page = 1, limit = 50 } = req.query;

    const where: any = {
      invariant: { contractAddress: req.params.address },
    };
    if (status) where.status = status;
    if (severity) where.severity = severity;

    const total = await prismaRead.invariantViolation.count({ where });
    const violations = await prismaRead.invariantViolation.findMany({
      where,
      include: { invariant: true },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { timestamp: 'desc' },
    });

    res.json({
      success: true,
      data: violations,
      total,
      page: Number(page),
      limit: Number(limit),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get contract violations: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get contract violations',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/contracts/:address/stats - Get contract statistics
 */
invariantsRouter.get('/contracts/:address/stats', async (req: Request, res: Response) => {
  try {
    const stats = await prismaRead.monitoringStats.findUnique({
      where: { contractAddress: req.params.address },
    });

    if (!stats) {
      return res.status(404).json({
        success: false,
        error: 'No statistics found for contract',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: {
        ...stats,
        successRate: stats.totalChecks > 0 ? Number(stats.passedChecks) / Number(stats.totalChecks) : 0,
        failureRate: stats.totalChecks > 0 ? Number(stats.failedChecks) / Number(stats.totalChecks) : 0,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get contract stats: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get contract stats',
      timestamp: new Date(),
    });
  }
});

/**
 * POST /api/v1/invariants/contracts/:address/setup - Auto-setup standard invariants
 */
invariantsRouter.post('/contracts/:address/setup', async (req: Request, res: Response) => {
  try {
    const { contractType } = req.body;

    if (!contractType) {
      return res.status(400).json({
        success: false,
        error: 'contractType required',
        timestamp: new Date(),
      });
    }

    // Get standard invariants for contract type
    const standards = await prismaRead.standardInvariant.findMany({
      where: {
        contractType,
        isEnabledByDefault: true,
      },
    });

    // Create invariant definitions from standards
    const created = await prisma.invariantDefinition.createMany({
      data: standards.map((std: StandardInvariantDTO) => ({
        name: `${std.name} (${req.params.address})`,
        description: std.description,
        category: std.category,
        contractAddress: req.params.address,
        expression: std.expressionTemplate,
        severity: std.severity,
        isActive: true,
        createdBy: (req as any)?.user?.address || 'system',
      })),
    });

    res.status(201).json({
      success: true,
      data: { created: created.count },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to setup standard invariants: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Setup failed',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// VIOLATIONS ENDPOINTS
// ============================================================================

/**
 * GET /api/v1/invariants/violations - List all violations
 */
invariantsRouter.get('/violations', async (req: Request, res: Response) => {
  try {
    const { status, severity, page = 1, limit = 50 } = req.query;

    const where: any = {};
    if (status) where.status = status;
    if (severity) where.severity = severity;

    const total = await prismaRead.invariantViolation.count({ where });
    const violations = await prismaRead.invariantViolation.findMany({
      where,
      include: { invariant: true },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      orderBy: { timestamp: 'desc' },
    });

    res.json({
      success: true,
      data: violations,
      total,
      page: Number(page),
      limit: Number(limit),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to list violations: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to list violations',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/violations/:id - Get violation details
 */
invariantsRouter.get('/violations/:id', async (req: Request, res: Response) => {
  try {
    const violation = await prismaRead.invariantViolation.findUnique({
      where: { id: BigInt(req.params.id) },
      include: {
        invariant: true,
        repairs: true,
      },
    });

    if (!violation) {
      return res.status(404).json({
        success: false,
        error: 'Violation not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: violation,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get violation: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get violation',
      timestamp: new Date(),
    });
  }
});

/**
 * PUT /api/v1/invariants/violations/:id - Update violation status
 */
invariantsRouter.put('/violations/:id', async (req: Request, res: Response) => {
  try {
    const { status, notes, assignedTo } = req.body;

    const violation = await prisma.invariantViolation.update({
      where: { id: BigInt(req.params.id) },
      data: {
        status,
        notes: notes || undefined,
        assignedTo: assignedTo || undefined,
      },
    });

    res.json({
      success: true,
      data: violation,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to update violation: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to update violation',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/violations/stats - Violation statistics
 */
invariantsRouter.get('/violations/stats', async (req: Request, res: Response) => {
  try {
    const stats = await prismaRead.invariantViolation.groupBy({
      by: ['severity', 'status'],
      _count: {
        id: true,
      },
    });

    const bySeverity = await prismaRead.invariantViolation.groupBy({
      by: ['severity'],
      _count: {
        id: true,
      },
    });

    res.json({
      success: true,
      data: {
        bySeverityAndStatus: stats,
        bySeverity,
        total: stats.reduce((sum, s) => sum + s._count.id, 0),
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get violation stats: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get violation stats',
      timestamp: new Date(),
    });
  }
});

// ============================================================================
// MONITORING ENDPOINTS
// ============================================================================

/**
 * POST /api/v1/invariants/monitoring/config - Set monitoring configuration
 */
invariantsRouter.post('/monitoring/config', async (req: Request, res: Response) => {
  try {
    const data = monitoringConfigSchema.parse(req.body);

    const config = await prisma.monitoringConfig.upsert({
      where: { contractAddress: data.contractAddress },
      create: data as any,
      update: data as any,
    });

    res.status(201).json({
      success: true,
      data: config,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to set monitoring config: ${error}`);
    res.status(400).json({
      success: false,
      error: 'Configuration failed',
      timestamp: new Date(),
    });
  }
});

/**
 * GET /api/v1/invariants/monitoring/config/:address - Get monitoring configuration
 */
invariantsRouter.get('/monitoring/config/:address', async (req: Request, res: Response) => {
  try {
    const config = await prismaRead.monitoringConfig.findUnique({
      where: { contractAddress: req.params.address },
      include: { stats: true },
    });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Monitoring config not found',
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      data: config,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(`Failed to get monitoring config: ${error}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get monitoring config',
      timestamp: new Date(),
    });
  }
});

// Export as part of main router
export default invariantsRouter;
