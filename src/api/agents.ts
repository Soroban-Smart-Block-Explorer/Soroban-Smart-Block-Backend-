/**
 * @swagger
 * tags:
 *   name: Agents
 *   description: Autonomous agent system — deploy, run, verify, communicate, and monitor on-chain agents
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAuth, optionalAuth } from '../auth/middleware';
import {
  agentEngine,
  marketplace,
  communicationBus,
  discoveryRegistry,
  agentReputation,
  agentMonitor,
  verificationNetwork,
} from '../agents';

export const agentRouter = Router();

// ── Validation Schemas ────────────────────────────────────────────────

const deploySchema = z.object({
  templateId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()),
  permissions: z
    .array(
      z.object({
        capability: z.enum(['can_swap', 'can_lend', 'can_vote', 'can_transfer', 'can_deploy']),
        agentId: z.string(),
        maxAmount: z.string().optional(),
        contracts: z.array(z.string()).optional(),
        expiresAt: z.number().optional(),
        nonce: z.string(),
        signature: z.string(),
      }),
    )
    .optional(),
  resourceLimits: z
    .object({
      maxGasPerExecution: z.number().optional(),
      maxGasPerDay: z.number().optional(),
      maxExecutionsPerDay: z.number().optional(),
      maxStorageBytes: z.number().optional(),
      maxConcurrentCalls: z.number().optional(),
      maxDrawdownPercent: z.number().optional(),
    })
    .optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(),
  permissions: z
    .array(
      z.object({
        capability: z.enum(['can_swap', 'can_lend', 'can_vote', 'can_transfer', 'can_deploy']),
        agentId: z.string(),
        maxAmount: z.string().optional(),
        contracts: z.array(z.string()).optional(),
        expiresAt: z.number().optional(),
        nonce: z.string(),
        signature: z.string(),
      }),
    )
    .optional(),
  resourceLimits: z
    .object({
      maxGasPerExecution: z.number().optional(),
      maxGasPerDay: z.number().optional(),
      maxExecutionsPerDay: z.number().optional(),
      maxStorageBytes: z.number().optional(),
      maxConcurrentCalls: z.number().optional(),
      maxDrawdownPercent: z.number().optional(),
    })
    .optional(),
});

const messageSchema = z.object({
  toAgentId: z.string(),
  type: z.enum([
    'request',
    'negotiate',
    'accept',
    'reject',
    'execute',
    'complete',
    'escalate',
    'rate',
  ]),
  subject: z.string().min(1),
  body: z.record(z.unknown()),
  responseToId: z.string().optional(),
});

const ratingSchema = z.object({
  toAgentId: z.string(),
  executionId: z.string().optional(),
  score: z.number().int().min(1).max(5),
  review: z.string().max(1000).optional(),
});

const registerSchema = z.object({
  capabilities: z.array(z.string()).min(1),
  pricePerCall: z.string().optional(),
  pricePerMonth: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Agent CRUD ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/agents:
 *   post:
 *     tags: [Agents]
 *     summary: Deploy a new agent from a template
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [templateId, name, config]
 *             properties:
 *               templateId: { type: string }
 *               name: { type: string }
 *               description: { type: string }
 *               config: { type: object }
 *               permissions: { type: array, items: { $ref: '#/components/schemas/CapabilityToken' } }
 *               resourceLimits: { $ref: '#/components/schemas/ResourceLimits' }
 *     responses:
 *       201: { description: Agent created }
 *       401: { description: Authentication required }
 */
agentRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const data = deploySchema.parse(req.body);
    const agent = await marketplace.deployFromTemplate({
      templateId: data.templateId,
      name: data.name,
      description: data.description,
      ownerAddress: req.user!.address,
      config: data.config,
      permissions: data.permissions,
      resourceLimits: data.resourceLimits,
    });
    res.status(201).json(agent);
  }),
);

/**
 * @swagger
 * /api/v1/agents:
 *   get:
 *     tags: [Agents]
 *     summary: List the current user's agents
 *     security: [{ ApiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Filter by agent status
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200: { description: List of agents }
 */
agentRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const result = await marketplace.listUserAgents(req.user!.address, {
      status: req.query.status as string | undefined,
      ...query,
    });
    res.json(result);
  }),
);

agentRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const agent = await marketplace.getAgentDetail(req.params.id);
    if (
      agent.ownerAddress !== req.user!.address &&
      req.user!.role !== 'admin' &&
      req.user!.role !== 'super_admin'
    ) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(agent);
  }),
);

agentRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const data = updateAgentSchema.parse(req.body);
    const agent = await marketplace.updateAgentConfig(req.params.id, req.user!.address, data);
    res.json(agent);
  }),
);

agentRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await marketplace.deleteAgent(req.params.id, req.user!.address);
    res.json({ success: true });
  }),
);

// ── Agent Lifecycle ───────────────────────────────────────────────────

agentRouter.post(
  '/:id/validate',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await agentEngine.transitionStatus(req.params.id, 'validating');
    // In production: run deterministic validation test
    await agentEngine.transitionStatus(req.params.id, 'active');
    res.json({ status: 'active', message: 'Agent validated successfully' });
  }),
);

agentRouter.post(
  '/:id/activate',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const agent = await marketplace.getAgentDetail(req.params.id);
    if (agent.ownerAddress !== req.user!.address) {
      return res.status(403).json({ error: 'Only the agent owner can activate' });
    }
    if (agent.status === 'validating' || agent.status === 'active') {
      await agentEngine.transitionStatus(req.params.id, 'running');
    }
    res.json({ status: 'running' });
  }),
);

agentRouter.post(
  '/:id/pause',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await agentEngine.transitionStatus(req.params.id, 'paused');
    res.json({ status: 'paused' });
  }),
);

agentRouter.post(
  '/:id/resume',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await agentEngine.transitionStatus(req.params.id, 'running');
    res.json({ status: 'running' });
  }),
);

agentRouter.post(
  '/:id/terminate',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await agentEngine.transitionStatus(req.params.id, 'terminated');
    res.json({ status: 'terminated' });
  }),
);

/**
 * @swagger
 * /api/v1/agents/{id}/execute:
 *   post:
 *     tags: [Agents]
 *     summary: Execute the agent (trigger single run)
 *     security: [{ ApiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Execution result with trace }
 */
agentRouter.post(
  '/:id/execute',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await agentEngine.executeAgent(req.params.id, 'manual');
    res.json(result);
  }),
);

// ── Executions & Traces ───────────────────────────────────────────────

agentRouter.get(
  '/:id/executions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const result = await agentMonitor.getAgentExecutions(req.params.id, {
      status: req.query.status as string | undefined,
      ...query,
    });
    res.json(result);
  }),
);

agentRouter.get(
  '/:id/trace/:executionId',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const trace = await agentMonitor.getExecutionTrace(req.params.executionId);
    if (trace.agentId !== req.params.id) {
      return res.status(404).json({ error: 'Execution not found for this agent' });
    }
    res.json(trace);
  }),
);

// ── Templates ─────────────────────────────────────────────────────────

agentRouter.get(
  '/templates',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const result = await marketplace.listTemplates({
      category: req.query.category as string | undefined,
      search: req.query.search as string | undefined,
      ...query,
    });
    res.json(result);
  }),
);

agentRouter.get(
  '/templates/:templateId',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const template = await marketplace.getTemplate(req.params.templateId);
    res.json(template);
  }),
);

// ── Agent Communication ───────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/agents/messages:
 *   post:
 *     tags: [Agents]
 *     summary: Send a message to another agent
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [toAgentId, type, subject, body]
 *             properties:
 *               toAgentId: { type: string }
 *               type: { type: string, enum: [request, negotiate, accept, reject, execute, complete, escalate, rate] }
 *               subject: { type: string }
 *               body: { type: object }
 *               responseToId: { type: string }
 *     responses:
 *       201: { description: Message sent }
 */
agentRouter.post(
  '/messages',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const data = messageSchema.parse(req.body);
    const messageId = await communicationBus.sendMessage({
      fromAgentId: req.params.fromAgentId || req.body.fromAgentId,
      toAgentId: data.toAgentId,
      type: data.type,
      subject: data.subject,
      body: data.body,
      responseToId: data.responseToId,
    });
    res.status(201).json({ messageId });
  }),
);

agentRouter.get(
  '/messages',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.query.agentId as string;
    const withAgent = req.query.withAgent as string;

    if (agentId && withAgent) {
      const messages = await communicationBus.getConversation(agentId, withAgent);
      return res.json({ messages });
    }

    const messages = await communicationBus.getUnreadMessages(agentId || '');
    res.json({ messages });
  }),
);

agentRouter.post(
  '/messages/:id/acknowledge',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const status = (req.body.status as string) || 'acknowledged';
    await communicationBus.acknowledgeMessage(
      req.params.id,
      status as 'delivered' | 'acknowledged' | 'rejected',
    );
    res.json({ success: true });
  }),
);

/**
 * @swagger
 * /api/v1/agents/negotiate:
 *   post:
 *     tags: [Agents]
 *     summary: Negotiate a service agreement between two agents
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fromAgentId, toAgentId, serviceType, params, budget]
 *             properties:
 *               fromAgentId: { type: string }
 *               toAgentId: { type: string }
 *               serviceType: { type: string }
 *               params: { type: object }
 *               budget: { type: string }
 *     responses:
 *       200: { description: Negotiation result }
 */
// ── Negotiation ───────────────────────────────────────────────────────

agentRouter.post(
  '/negotiate',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { fromAgentId, toAgentId, serviceType, params, budget } = z
      .object({
        fromAgentId: z.string(),
        toAgentId: z.string(),
        serviceType: z.string(),
        params: z.record(z.unknown()),
        budget: z.string(),
      })
      .parse(req.body);

    const result = await communicationBus.negotiate({
      fromAgentId,
      toAgentId,
      serviceType,
      params,
      budget,
    });

    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/agents/registry:
 *   get:
 *     tags: [Agents]
 *     summary: Find registered agent providers by capability
 *     parameters:
 *       - in: query
 *         name: capability
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: string }
 *     responses:
 *       200: { description: List of matching providers }
 *   post:
 *     tags: [Agents]
 *     summary: Register agent capabilities in the discovery registry
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentId, capabilities]
 *             properties:
 *               agentId: { type: string }
 *               capabilities: { type: array, items: { type: string } }
 *               pricePerCall: { type: string }
 *               pricePerMonth: { type: string }
 *               metadata: { type: object }
 *     responses:
 *       201: { description: Registered }
 */
// ── Discovery Registry ────────────────────────────────────────────────

agentRouter.get(
  '/registry',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const capability = req.query.capability as string;
    const maxPrice = req.query.maxPrice as string | undefined;

    if (capability) {
      const providers = await discoveryRegistry.findProviders(capability, maxPrice);
      return res.json({ providers });
    }

    res.json({ providers: [] });
  }),
);

agentRouter.post(
  '/registry',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const data = registerSchema.parse(req.body);
    const agentId = req.body.agentId as string;
    await discoveryRegistry.register({
      agentId,
      capabilities: data.capabilities,
      pricePerCall: data.pricePerCall,
      pricePerMonth: data.pricePerMonth,
      metadata: data.metadata,
    });
    res.status(201).json({ success: true });
  }),
);

// ── Ratings ───────────────────────────────────────────────────────────

agentRouter.post(
  '/ratings',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const data = ratingSchema.parse(req.body);
    const fromAgentId = req.body.fromAgentId as string;
    await agentReputation.submitRating({
      fromAgentId,
      toAgentId: data.toAgentId,
      executionId: data.executionId,
      score: data.score,
      review: data.review,
    });
    res.status(201).json({ success: true });
  }),
);

agentRouter.get(
  '/ratings/:agentId',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const ratings = await agentReputation.getAgentRating(req.params.agentId);
    res.json(ratings);
  }),
);

/**
 * @swagger
 * /api/v1/agents/escalations:
 *   post:
 *     tags: [Agents]
 *     summary: Escalate an agent decision to a human operator
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agentId, context, proposedActions]
 *             properties:
 *               agentId: { type: string }
 *               context: { type: object }
 *               proposedActions: { type: array, items: { type: object } }
 *     responses:
 *       201: { description: Escalation created }
 */
// ── Escalations ───────────────────────────────────────────────────────

agentRouter.post(
  '/escalations',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId, context, proposedActions } = z
      .object({
        agentId: z.string(),
        context: z.record(z.unknown()),
        proposedActions: z.array(z.record(z.unknown())),
      })
      .parse(req.body);

    const { prismaWrite } = await import('../db');
    const escalation = await prismaWrite.agentEscalation.create({
      data: {
        agentId,
        context: context as any,
        proposedActions: proposedActions as any,
      },
    });

    res.status(201).json(escalation);
  }),
);

agentRouter.get(
  '/escalations/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { prismaRead } = await import('../db');
    const escalation = await prismaRead.agentEscalation.findUnique({
      where: { id: req.params.id },
      include: { agent: { select: { name: true, templateId: true } } },
    });
    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });
    res.json(escalation);
  }),
);

agentRouter.post(
  '/escalations/:id/resolve',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { resolution, status } = z
      .object({
        resolution: z.record(z.unknown()),
        status: z.enum(['resolved', 'rejected']),
      })
      .parse(req.body);

    const { prismaWrite } = await import('../db');
    const escalation = await prismaWrite.agentEscalation.update({
      where: { id: req.params.id },
      data: {
        status,
        resolution: resolution as any,
        resolvedBy: req.user!.address,
        resolvedAt: new Date(),
      },
    });

    res.json(escalation);
  }),
);

/**
 * @swagger
 * /api/v1/agents/monitoring/dashboard:
 *   get:
 *     tags: [Agents]
 *     summary: Get agent monitoring dashboard for the current user
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: Dashboard with agent health, alerts, usage }
 */
// ── Monitoring ────────────────────────────────────────────────────────

agentRouter.get(
  '/monitoring/dashboard',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const dashboard = await agentMonitor.getDashboard(req.user!.address);
    res.json(dashboard);
  }),
);

agentRouter.get(
  '/monitoring/alerts',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const query = paginationSchema.parse(req.query);
    const alerts = await agentMonitor.getAlerts({
      agentId: req.query.agentId as string | undefined,
      severity: req.query.severity as string | undefined,
      acknowledged:
        req.query.acknowledged !== undefined ? req.query.acknowledged === 'true' : undefined,
      ...query,
    });
    res.json(alerts);
  }),
);

agentRouter.post(
  '/monitoring/alerts/:id/acknowledge',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await agentMonitor.acknowledgeAlert(req.params.id);
    res.json({ success: true });
  }),
);

agentRouter.get(
  '/monitoring/analytics',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const analytics = await agentMonitor.getAnalyticsSummary(req.user!.address);
    res.json(analytics);
  }),
);

agentRouter.get(
  '/monitoring/analytics/market',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const analytics = await marketplace.getAnalytics({
      category: req.query.category as string | undefined,
      days: req.query.days ? Number(req.query.days) : undefined,
    });
    res.json(analytics);
  }),
);

/**
 * @swagger
 * /api/v1/agents/verification/{executionId}:
 *   get:
 *     tags: [Agents]
 *     summary: Get verification status for an execution
 *     parameters:
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Verification status with node results }
 *   post:
 *     tags: [Agents]
 *     summary: Submit a verification result for an execution trace
 *     security: [{ ApiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [verifierNode]
 *             properties:
 *               verifierNode: { type: string }
 *     responses:
 *       200: { description: Verification result (match/mismatch) }
 */
// ── Verification ──────────────────────────────────────────────────────

agentRouter.get(
  '/verification/:executionId',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const status = await verificationNetwork.getVerificationStatus(req.params.executionId);
    res.json(status);
  }),
);

agentRouter.post(
  '/verification/:executionId/verify',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { verifierNode } = z
      .object({
        verifierNode: z.string(),
      })
      .parse(req.body);

    const result = await verificationNetwork.verifyExecutionTrace(
      req.params.executionId,
      verifierNode,
    );

    res.json(result);
  }),
);

agentRouter.get(
  '/verification/summary/:agentId',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const summary = await verificationNetwork.getVerificationSummary(req.params.agentId);
    res.json(summary);
  }),
);

// ── Admin: Route verification nodes ───────────────────────────────────

agentRouter.post(
  '/verification/nodes',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    if (req.user!.role !== 'admin' && req.user!.role !== 'super_admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { nodeId, name, publicKey } = z
      .object({
        nodeId: z.string(),
        name: z.string(),
        publicKey: z.string(),
      })
      .parse(req.body);

    verificationNetwork.registerVerifierNode(nodeId, name, publicKey);
    res.status(201).json({ success: true });
  }),
);
