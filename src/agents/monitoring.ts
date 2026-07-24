import { prismaRead, prismaWrite } from '../db';
import { logger } from '../logger';

class AgentMonitor {
  private static instance: AgentMonitor;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  static getInstance(): AgentMonitor {
    if (!AgentMonitor.instance) {
      AgentMonitor.instance = new AgentMonitor();
    }
    return AgentMonitor.instance;
  }

  start(intervalMs = 60_000): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => this.runHealthChecks(), intervalMs);
    logger.info(`Agent monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async runHealthChecks(): Promise<void> {
    try {
      const activeAgents = await prismaRead.agent.findMany({
        where: { status: { in: ['active', 'running'] } },
      });

      for (const agent of activeAgents) {
        await this.checkAgentHealth(agent);
      }
    } catch (err) {
      logger.error(`Health check run failed: ${err}`);
    }
  }

  private async checkAgentHealth(agent: Record<string, unknown>): Promise<void> {
    const agentId = agent.id as string;
    const limits = (agent.resourceLimits as Record<string, number>) || {};

    // Inactivity check
    if (agent.lastExecutionAt) {
      const inactiveHours =
        (Date.now() - new Date(agent.lastExecutionAt as string).getTime()) / (1000 * 60 * 60);
      if (inactiveHours > 24) {
        await this.createAlertIfNotExisting(
          agentId,
          'inactivity',
          'warning',
          `Agent has not executed in ${Math.round(inactiveHours)} hours`,
        );
      }
    } else if (agent.status === 'running') {
      // Agent is running but never executed - check if it's been more than 24h since activation
      const createdAt = new Date(agent.createdAt as string);
      const hoursSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCreation > 24) {
        await this.createAlertIfNotExisting(
          agentId,
          'inactivity',
          'warning',
          `Agent has never executed (${Math.round(hoursSinceCreation)} hours since creation)`,
        );
      }
    }

    // Failure rate check
    if (Number(agent.totalExecutions) >= 5) {
      const recentExecs = await prismaRead.agentExecution.findMany({
        where: { agentId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (recentExecs.length >= 5) {
        const failures = recentExecs.filter((e) => e.status === 'failed').length;
        const failureRate = failures / recentExecs.length;
        if (failureRate > 0.1) {
          await this.createAlertIfNotExisting(
            agentId,
            'high_failure_rate',
            'critical',
            `Failure rate ${(failureRate * 100).toFixed(1)}% exceeds 10% threshold (${failures}/${recentExecs.length} executions)`,
          );
        }
      }
    }

    // Budget check
    const dayGas = Number(agent.currentDayGasUsed || 0);
    const maxGas = limits.maxGasPerDay || 10_000_000;
    if (dayGas > maxGas * 0.8) {
      await this.createAlertIfNotExisting(
        agentId,
        'budget_exceeded',
        'warning',
        `Gas usage at ${((dayGas / maxGas) * 100).toFixed(1)}% of daily budget (${dayGas}/${maxGas})`,
      );
    }
  }

  private async createAlertIfNotExisting(
    agentId: string,
    type: string,
    severity: string,
    message: string,
  ): Promise<void> {
    const existing = await prismaRead.agentAlert.findFirst({
      where: {
        agentId,
        type: type as never,
        acknowledged: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (!existing) {
      await prismaWrite.agentAlert.create({
        data: {
          agentId,
          type: type as never,
          severity: severity as never,
          message,
        },
      });
      await prismaWrite.agent.update({
        where: { id: agentId },
        data: { lastAlertAt: new Date() },
      });
    }
  }

  async getDashboard(ownerAddress?: string) {
    const where: Record<string, unknown> = {};
    if (ownerAddress) where.ownerAddress = ownerAddress;

    const agents = await prismaRead.agent.findMany({
      where: where as Record<string, unknown>,
      include: {
        _count: {
          select: {
            executions: {
              where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            },
            alerts: { where: { acknowledged: false } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const statusCounts: Record<string, number> = {};
    for (const a of agents) {
      const s = a.status as string;
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    const totalAgents = agents.length;
    const activeAgents = agents.filter(
      (a) => a.status === 'active' || a.status === 'running',
    ).length;
    const totalUnacknowledgedAlerts = agents.reduce((sum, a) => sum + a._count.alerts, 0);
    const totalRecentExecs = agents.reduce((sum, a) => sum + a._count.executions, 0);

    return {
      summary: {
        totalAgents,
        activeAgents,
        pausedAgents: agents.filter((a) => a.status === 'paused').length,
        terminatedAgents: agents.filter((a) => a.status === 'terminated').length,
        totalUnacknowledgedAlerts,
        totalRecentExecutions: totalRecentExecs,
      },
      statusDistribution: statusCounts,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        templateId: a.templateId,
        status: a.status,
        totalExecutions: a.totalExecutions,
        successfulExecutions: a.successfulExecutions,
        failureCount: a.failureCount,
        totalGasUsed: a.totalGasUsed?.toString() || '0',
        recentExecutions: a._count.executions,
        unacknowledgedAlerts: a._count.alerts,
        lastExecutionAt: a.lastExecutionAt,
        createdAt: a.createdAt,
      })),
    };
  }

  async getAlerts(params: {
    agentId?: string;
    severity?: string;
    acknowledged?: boolean;
    page?: number;
    limit?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.agentId) where.agentId = params.agentId;
    if (params.severity) where.severity = params.severity as never;
    if (params.acknowledged !== undefined) where.acknowledged = params.acknowledged;

    const [alerts, total] = await Promise.all([
      prismaRead.agentAlert.findMany({
        where: where as Record<string, unknown>,
        orderBy: { createdAt: 'desc' },
        skip: ((params.page || 1) - 1) * (params.limit || 50),
        take: params.limit || 50,
        include: {
          agent: { select: { name: true, templateId: true } },
        },
      }),
      prismaRead.agentAlert.count({ where: where as Record<string, unknown> }),
    ]);

    return { alerts, total, page: params.page || 1, limit: params.limit || 50 };
  }

  async acknowledgeAlert(alertId: string): Promise<void> {
    await prismaWrite.agentAlert.update({
      where: { id: alertId },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });
  }

  async getExecutionTrace(executionId: string) {
    const execution = await prismaRead.agentExecution.findUnique({
      where: { id: executionId },
      include: {
        agent: { select: { name: true, templateId: true } },
        verifications: true,
        ratings: true,
      },
    });

    if (!execution) throw new Error(`Execution ${executionId} not found`);
    return execution;
  }

  async getAgentExecutions(
    agentId: string,
    params: { status?: string; page?: number; limit?: number },
  ) {
    const where: Record<string, unknown> = { agentId };
    if (params.status) where.status = params.status;

    const [executions, total] = await Promise.all([
      prismaRead.agentExecution.findMany({
        where: where as Record<string, unknown>,
        orderBy: { createdAt: 'desc' },
        skip: ((params.page || 1) - 1) * (params.limit || 50),
        take: params.limit || 50,
      }),
      prismaRead.agentExecution.count({ where: where as Record<string, unknown> }),
    ]);

    return { executions, total, page: params.page || 1, limit: params.limit || 50 };
  }

  async getAnalyticsSummary(ownerAddress?: string) {
    const where: Record<string, unknown> = {};
    if (ownerAddress) where.ownerAddress = ownerAddress;

    const agents = await prismaRead.agent.findMany({
      where: where as Record<string, unknown>,
    });

    const agentIds = agents.map((a) => a.id);

    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [executions7d, executions30d, alerts] = await Promise.all([
      prismaRead.agentExecution.findMany({
        where: {
          agentId: { in: agentIds.length > 0 ? agentIds : [''] },
          createdAt: { gte: last7d },
        },
      }),
      prismaRead.agentExecution.findMany({
        where: {
          agentId: { in: agentIds.length > 0 ? agentIds : [''] },
          createdAt: { gte: last30d },
        },
      }),
      prismaRead.agentAlert.findMany({
        where: {
          agentId: { in: agentIds.length > 0 ? agentIds : [''] },
          acknowledged: false,
        },
      }),
    ]);

    const calcStats = (execs: typeof executions7d) => {
      const total = execs.length;
      const success = execs.filter((e) => e.status === 'success').length;
      return {
        total,
        successful: success,
        failed: total - success,
        successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 0,
        gasUsed: execs.reduce((s, e) => s + Number(e.gasUsed || 0), 0),
      };
    };

    return {
      agents: {
        total: agents.length,
        active: agents.filter((a) => a.status === 'active' || a.status === 'running').length,
        paused: agents.filter((a) => a.status === 'paused').length,
      },
      executions7d: calcStats(executions7d),
      executions30d: calcStats(executions30d),
      unacknowledgedAlerts: alerts.length,
    };
  }
}

export const agentMonitor = AgentMonitor.getInstance();
