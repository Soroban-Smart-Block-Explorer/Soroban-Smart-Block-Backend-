import { prismaRead, prismaWrite } from '../db';
import { agentTemplates, seedTemplates } from './templates';
import { agentEngine } from './engine';
import type { CapabilityToken, ResourceLimits } from './types';
import { logger } from '../logger';

class AgentMarketplace {
  private static instance: AgentMarketplace;

  static getInstance(): AgentMarketplace {
    if (!AgentMarketplace.instance) {
      AgentMarketplace.instance = new AgentMarketplace();
    }
    return AgentMarketplace.instance;
  }

  async initialize(): Promise<void> {
    await seedTemplates();
    logger.info('Agent marketplace initialized with templates');
  }

  async listTemplates(params: {
    category?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const where: Record<string, unknown> = { isPublished: true };
    if (params.category) where.category = params.category;
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [templates, total] = await Promise.all([
      prismaRead.agentTemplate.findMany({
        where: where as Record<string, unknown>,
        orderBy: { downloadCount: 'desc' },
        skip: ((params.page || 1) - 1) * (params.limit || 20),
        take: params.limit || 20,
      }),
      prismaRead.agentTemplate.count({ where: where as Record<string, unknown> }),
    ]);

    return { templates, total, page: params.page || 1, limit: params.limit || 20 };
  }

  async getTemplate(templateId: string) {
    const template = await prismaRead.agentTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template) throw new Error(`Template ${templateId} not found`);
    return template;
  }

  async deployFromTemplate(params: {
    templateId: string;
    name: string;
    description?: string;
    ownerAddress: string;
    config: Record<string, unknown>;
    permissions?: CapabilityToken[];
    resourceLimits?: Partial<ResourceLimits>;
  }) {
    await this.incrementDownloads(params.templateId);

    const agent = await agentEngine.createAgent(params);
    return agent;
  }

  async listUserAgents(
    ownerAddress: string,
    params: { status?: string; page?: number; limit?: number },
  ) {
    const where: Record<string, unknown> = { ownerAddress };
    if (params.status) where.status = params.status;

    const [agents, total] = await Promise.all([
      prismaRead.agent.findMany({
        where: where as Record<string, unknown>,
        orderBy: { createdAt: 'desc' },
        skip: ((params.page || 1) - 1) * (params.limit || 20),
        take: params.limit || 20,
        include: {
          _count: {
            select: {
              executions: true,
              alerts: { where: { acknowledged: false } },
            },
          },
        },
      }),
      prismaRead.agent.count({ where: where as Record<string, unknown> }),
    ]);

    return { agents, total, page: params.page || 1, limit: params.limit || 20 };
  }

  async getAgentDetail(agentId: string) {
    const agent = await prismaRead.agent.findUnique({
      where: { id: agentId },
      include: {
        _count: {
          select: {
            executions: true,
            messagesSent: true,
            messagesRecv: true,
            alerts: { where: { acknowledged: false } },
            ratingsRecv: true,
          },
        },
      },
    });

    if (!agent) throw new Error(`Agent ${agentId} not found`);
    return agent;
  }

  async updateAgentConfig(
    agentId: string,
    ownerAddress: string,
    updates: {
      name?: string;
      description?: string;
      config?: Record<string, unknown>;
      permissions?: CapabilityToken[];
      resourceLimits?: Partial<ResourceLimits>;
    },
  ) {
    const agent = await prismaRead.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.ownerAddress !== ownerAddress) {
      throw new Error('Only the agent owner can update configuration');
    }

    const data: Record<string, unknown> = {};
    if (updates.name) data.name = updates.name;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.config) data.config = updates.config;
    if (updates.permissions) data.permissions = updates.permissions;
    if (updates.resourceLimits) {
      data.resourceLimits = {
        ...(agent.resourceLimits as Record<string, unknown>),
        ...updates.resourceLimits,
      };
    }

    return prismaWrite.agent.update({
      where: { id: agentId },
      data,
    });
  }

  async deleteAgent(agentId: string, ownerAddress: string): Promise<void> {
    const agent = await prismaRead.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.ownerAddress !== ownerAddress) {
      throw new Error('Only the agent owner can delete an agent');
    }

    await prismaWrite.agent.update({
      where: { id: agentId },
      data: { status: 'archived' },
    });
  }

  async getAnalytics(params: { category?: string; days?: number }) {
    const days = params.days || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const agents = await prismaRead.agent.findMany({
      where: {
        createdAt: { gte: since },
        ...(params.category
          ? {
              templateId: {
                in: agentTemplates.filter((t) => t.category === params.category).map((t) => t.id),
              },
            }
          : {}),
      },
      include: {
        _count: { select: { executions: true } },
      },
    });

    const executions = await prismaRead.agentExecution.findMany({
      where: { createdAt: { gte: since } },
    });

    const totalExecutions = executions.length;
    const successfulExecutions = executions.filter((e) => e.status === 'success').length;
    const successRate = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0;
    const totalGasUsed = executions.reduce((sum, e) => sum + Number(e.gasUsed || 0), 0);

    // Per-template aggregation
    const templateStats: Record<
      string,
      { count: number; executions: number; gasUsed: number; failures: number }
    > = {};
    for (const agent of agents) {
      const tid = agent.templateId || 'unknown';
      if (!templateStats[tid]) {
        templateStats[tid] = { count: 0, executions: 0, gasUsed: 0, failures: 0 };
      }
      templateStats[tid].count++;
    }
    for (const exec of executions) {
      const agent = agents.find((a) => a.id === exec.agentId);
      const tid = agent?.templateId || 'unknown';
      if (!templateStats[tid]) {
        templateStats[tid] = { count: 0, executions: 0, gasUsed: 0, failures: 0 };
      }
      templateStats[tid].executions++;
      templateStats[tid].gasUsed += Number(exec.gasUsed || 0);
      if (exec.status === 'failed') templateStats[tid].failures++;
    }

    const templateNames: Record<string, string> = {};
    for (const t of agentTemplates) {
      templateNames[t.id] = t.name;
    }

    return {
      summary: {
        totalAgents: agents.length,
        totalExecutions,
        successfulExecutions,
        failedExecutions: totalExecutions - successfulExecutions,
        successRate: Math.round(successRate * 100) / 100,
        totalGasUsed,
        periodDays: days,
      },
      perTemplate: Object.entries(templateStats)
        .map(([id, stats]) => ({
          templateId: id,
          templateName: templateNames[id] || id,
          agentCount: stats.count,
          executionCount: stats.executions,
          gasUsed: stats.gasUsed,
          failureRate:
            stats.executions > 0
              ? Math.round((stats.failures / stats.executions) * 10000) / 100
              : 0,
        }))
        .sort((a, b) => b.executionCount - a.executionCount),
    };
  }

  private async incrementDownloads(templateId: string): Promise<void> {
    await prismaWrite.agentTemplate.update({
      where: { id: templateId },
      data: { downloadCount: { increment: 1 } },
    });
  }
}

export const marketplace = AgentMarketplace.getInstance();
