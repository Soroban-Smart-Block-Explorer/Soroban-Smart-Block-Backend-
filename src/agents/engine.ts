import crypto from 'crypto';
import { prismaWrite } from '../db';
import type {
  AgentStatus,
  CapabilityToken,
  ResourceLimits,
  ExecutionTrace,
  ExecutionStep,
  DCAConfig,
  GovernanceConfig,
  YieldOptimizerConfig,
  MevProtectorConfig,
  StopLossConfig,
  LiquidationSniperConfig,
  ComplianceConfig,
} from './types';
import { DEFAULT_RESOURCE_LIMITS } from './types';
import { agentTemplates } from './templates';
import { logger } from '../logger';

export class AgentEngine {
  private static instance: AgentEngine;

  static getInstance(): AgentEngine {
    if (!AgentEngine.instance) {
      AgentEngine.instance = new AgentEngine();
    }
    return AgentEngine.instance;
  }

  async createAgent(params: {
    name: string;
    description?: string;
    ownerAddress: string;
    templateId: string;
    config: Record<string, unknown>;
    permissions?: CapabilityToken[];
    resourceLimits?: Partial<ResourceLimits>;
  }) {
    const template = agentTemplates.find((t) => t.id === params.templateId);
    if (!template) throw new Error(`Template ${params.templateId} not found`);

    const limits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...template.defaultLimits,
      ...params.resourceLimits,
    };

    const agent = await prismaWrite.agent.create({
      data: {
        name: params.name,
        description: params.description,
        ownerAddress: params.ownerAddress,
        templateId: params.templateId,
        status: 'deployed',
        permissions: (params.permissions || template.defaultPermissions) as any,
        resourceLimits: limits as any,
        config: params.config as any,
        maxDrawdown: limits.maxDrawdownPercent,
        currentDrawdown: 0,
        totalGasUsed: 0,
        currentDayGasUsed: 0,
        gasResetAt: new Date(),
        metadata: {
          templateName: template.name,
          templateVersion: template.version,
          templateCategory: template.category,
        },
      },
    });

    logger.info(`Agent created: ${agent.id} (${params.name}) for ${params.ownerAddress}`);
    return agent;
  }

  async transitionStatus(agentId: string, newStatus: AgentStatus): Promise<void> {
    const validTransitions: Record<AgentStatus, AgentStatus[]> = {
      deployed: ['validating', 'terminated'],
      validating: ['active', 'terminated'],
      active: ['running', 'terminated'],
      running: ['paused', 'terminated'],
      paused: ['running', 'terminated'],
      terminated: ['archived'],
      archived: [],
    };

    const agent = await prismaWrite.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const currentStatus = agent.status as AgentStatus;
    const allowed = validTransitions[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${currentStatus} -> ${newStatus}`);
    }

    const updateData: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'active') {
      updateData.lastExecutionAt = null;
    }

    await prismaWrite.agent.update({
      where: { id: agentId },
      data: updateData,
    });

    logger.info(`Agent ${agentId} transitioned: ${currentStatus} -> ${newStatus}`);
  }

  async executeAgent(
    agentId: string,
    trigger: 'scheduled' | 'manual' | 'event' = 'scheduled',
  ): Promise<{ executionId: string; action: Record<string, unknown> | null; success: boolean }> {
    const agent = await prismaWrite.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const agentStatus = agent.status as string;
    if (agentStatus !== 'active' && agentStatus !== 'running') {
      throw new Error(`Agent ${agentId} is not running (status: ${agentStatus})`);
    }

    // Check resource limits
    await this.enforceResourceLimits(agent);

    const template = agentTemplates.find((t) => t.id === agent.templateId);
    if (!template) throw new Error(`Template ${agent.templateId} not found`);

    const config = agent.config as Record<string, unknown>;
    const permissions = (agent.permissions as unknown as CapabilityToken[]) || [];

    // Build input state snapshot (deterministic)
    const inputState = this.captureInputState(agent, config);
    const inputStateHash = this.hashState(inputState);

    const steps: ExecutionStep[] = [];
    let stepIndex = 0;
    let error: string | null = null;
    let outputAction: Record<string, unknown> | null = null;

    try {
      switch (agent.templateId) {
        case 'dca':
          outputAction = await this.executeDCA(
            agent,
            config as unknown as DCAConfig,
            steps,
            stepIndex,
          );
          break;
        case 'governance':
          outputAction = await this.executeGovernance(
            agent,
            config as unknown as GovernanceConfig,
            steps,
            stepIndex,
          );
          break;
        case 'yield-optimizer':
          outputAction = await this.executeYieldOptimizer(
            agent,
            config as unknown as YieldOptimizerConfig,
            steps,
            stepIndex,
          );
          break;
        case 'mev-protector':
          outputAction = await this.executeMevProtector(
            agent,
            config as unknown as MevProtectorConfig,
            steps,
            stepIndex,
          );
          break;
        case 'stop-loss':
          outputAction = await this.executeStopLoss(
            agent,
            config as unknown as StopLossConfig,
            steps,
            stepIndex,
          );
          break;
        case 'liquidation-sniper':
          outputAction = await this.executeLiquidationSniper(
            agent,
            config as unknown as LiquidationSniperConfig,
            steps,
            stepIndex,
          );
          break;
        case 'compliance':
          outputAction = await this.executeCompliance(
            agent,
            config as unknown as ComplianceConfig,
            steps,
            stepIndex,
          );
          break;
        default:
          throw new Error(`Unknown template: ${agent.templateId}`);
      }

      if (outputAction) {
        this.validateActionPermissions(outputAction, permissions);
      }
    } catch (err) {
      error = String(err);
      steps.push({
        stepIndex: ++stepIndex,
        description: 'Execution failed',
        input: {},
        reasoning: `Error: ${error}`,
        output: { error },
        gasUsed: 0,
      });
    }

    const totalGasUsed = steps.reduce((sum, s) => sum + s.gasUsed, 0);
    const finalStateHash = this.hashState({ ...inputState, outputAction, steps });

    // Build trace
    const trace: ExecutionTrace = {
      executionId: crypto.randomUUID(),
      agentId,
      inputStateHash,
      steps,
      outputAction,
      finalStateHash,
      signature: '', // Will be signed
    };

    trace.signature = this.signTrace(trace);

    // Record execution
    const execution = await prismaWrite.agentExecution.create({
      data: {
        agentId,
        status: error ? 'failed' : 'success',
        trigger,
        inputState: inputState as any,
        decision: outputAction
          ? { action: outputAction.type, params: outputAction }
          : (null as any),
        outputAction: outputAction as any,
        reasoning: steps.map((s) => ({ step: s.stepIndex, reasoning: s.reasoning })),
        gasUsed: totalGasUsed,
        trace: trace as any,
        traceHash: finalStateHash,
        signature: trace.signature,
        error,
        completedAt: new Date(),
      },
    });

    // Update agent stats
    await prismaWrite.agent.update({
      where: { id: agentId },
      data: {
        totalExecutions: { increment: 1 },
        successfulExecutions: error ? undefined : { increment: 1 },
        failureCount: error ? { increment: 1 } : undefined,
        totalGasUsed: { increment: totalGasUsed },
        currentDayGasUsed: { increment: totalGasUsed },
        lastExecutionAt: new Date(),
        ...(error ? { status: 'active' } : {}),
      },
    });

    // Check circuit breakers
    if (error) {
      await this.checkCircuitBreakers(agentId);
    }

    // Reset daily gas if needed
    await this.resetDailyGasIfNeeded(agentId);

    return {
      executionId: execution.id,
      action: outputAction,
      success: !error,
    };
  }

  private captureInputState(
    agent: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    // Deterministic state snapshot - sorts keys for consistent hashing
    const state: Record<string, unknown> = {
      agentId: agent.id,
      templateId: agent.templateId,
      config: this.sortObject(config),
      totalExecutions: agent.totalExecutions,
      successfulExecutions: agent.successfulExecutions,
      currentDrawdown: agent.currentDrawdown,
      timestamp: 0, // Zeroed out for determinism - actual time passed separately
    };
    return this.sortObject(state);
  }

  private hashState(state: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
  }

  private signTrace(trace: ExecutionTrace): string {
    const content = `${trace.executionId}:${trace.agentId}:${trace.inputStateHash}:${trace.finalStateHash}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private sortObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj))
      return obj.map((item) =>
        typeof item === 'object' && item !== null
          ? this.sortObject(item as Record<string, unknown>)
          : item,
      ) as unknown as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    Object.keys(obj)
      .sort()
      .forEach((key) => {
        sorted[key] =
          typeof obj[key] === 'object' && obj[key] !== null
            ? this.sortObject(obj[key] as Record<string, unknown>)
            : obj[key];
      });
    return sorted;
  }

  private validateActionPermissions(
    action: Record<string, unknown>,
    permissions: CapabilityToken[],
  ): void {
    const actionType = action.type as string;
    const permissionMap: Record<string, string> = {
      swap: 'can_swap',
      lend: 'can_lend',
      vote: 'can_vote',
      transfer: 'can_transfer',
      deploy: 'can_deploy',
    };

    const requiredCap = permissionMap[actionType];
    if (!requiredCap) return; // monitor-only actions don't need permissions

    const matchingPerm = permissions.find((p) => p.capability === requiredCap);
    if (!matchingPerm) {
      throw new Error(`Agent does not have ${requiredCap} permission`);
    }

    // Verify signature (simplified - in production, verify Ed25519)
    if (!matchingPerm.signature) {
      throw new Error(`Capability token for ${requiredCap} is not signed`);
    }

    // Check expiry
    if (matchingPerm.expiresAt && Date.now() > matchingPerm.expiresAt * 1000) {
      throw new Error(`Capability token for ${requiredCap} has expired`);
    }

    // Check amount limits
    if (matchingPerm.maxAmount && action.amount) {
      if (Number(action.amount) > Number(matchingPerm.maxAmount)) {
        throw new Error(
          `Action amount ${action.amount} exceeds permission limit ${matchingPerm.maxAmount}`,
        );
      }
    }
  }

  private async enforceResourceLimits(agent: Record<string, unknown>): Promise<void> {
    const limits = (agent.resourceLimits as ResourceLimits) || DEFAULT_RESOURCE_LIMITS;

    // Check daily gas
    const dayGas = Number(agent.currentDayGasUsed || 0);
    if (dayGas >= limits.maxGasPerDay) {
      await this.createAlert(
        agent.id as string,
        'budget_exceeded',
        'critical',
        `Daily gas budget exhausted: ${dayGas}/${limits.maxGasPerDay}`,
      );
      await this.transitionStatus(agent.id as string, 'paused');
      throw new Error(`Daily gas budget exhausted: ${dayGas}/${limits.maxGasPerDay}`);
    }

    // Check max executions per day
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await prismaWrite.agentExecution.count({
      where: {
        agentId: agent.id as string,
        createdAt: { gte: today },
      },
    });
    if (todayCount >= limits.maxExecutionsPerDay) {
      throw new Error(`Daily execution limit reached: ${todayCount}/${limits.maxExecutionsPerDay}`);
    }
  }

  private async resetDailyGasIfNeeded(agentId: string): Promise<void> {
    const agent = await prismaWrite.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;

    const lastReset = agent.gasResetAt;
    const now = new Date();
    if (lastReset && now.getTime() - lastReset.getTime() > 24 * 60 * 60 * 1000) {
      await prismaWrite.agent.update({
        where: { id: agentId },
        data: { currentDayGasUsed: 0, gasResetAt: now },
      });
    }
  }

  async checkCircuitBreakers(agentId: string): Promise<void> {
    const agent = await prismaWrite.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;

    // Check failure rate (last 20 executions)
    if (agent.totalExecutions >= 5) {
      const recentExecutions = await prismaWrite.agentExecution.findMany({
        where: { agentId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (recentExecutions.length >= 5) {
        const failures = recentExecutions.filter((e) => e.status === 'failed').length;
        const failureRate = failures / recentExecutions.length;
        if (failureRate > 0.1) {
          await this.createAlert(
            agentId,
            'high_failure_rate',
            'critical',
            `Failure rate ${(failureRate * 100).toFixed(1)}% exceeds 10% threshold`,
          );
          await this.transitionStatus(agentId, 'paused');
          return;
        }
      }
    }

    // Check drawdown
    if (agent.currentDrawdown && agent.maxDrawdown) {
      const dd = Number(agent.currentDrawdown);
      const maxDd = Number(agent.maxDrawdown);
      if (Math.abs(dd) > maxDd) {
        await this.createAlert(
          agentId,
          'circuit_break',
          'critical',
          `Max drawdown exceeded: ${dd}% vs ${maxDd}% limit`,
        );
        await this.transitionStatus(agentId, 'paused');
      }
    }

    // Check inactivity
    if (agent.lastExecutionAt) {
      const inactiveHours = (Date.now() - agent.lastExecutionAt.getTime()) / (1000 * 60 * 60);
      if (inactiveHours > 24) {
        await this.createAlert(
          agentId,
          'inactivity',
          'warning',
          `Agent has not executed in ${Math.round(inactiveHours)} hours`,
        );
      }
    }
  }

  async createAlert(
    agentId: string,
    type:
      | 'inactivity'
      | 'high_failure_rate'
      | 'budget_exceeded'
      | 'circuit_break'
      | 'verification_failure',
    severity: 'info' | 'warning' | 'critical',
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await prismaWrite.agentAlert.create({
      data: {
        agentId,
        type,
        severity,
        message,
        data: (data || {}) as any,
      },
    });

    await prismaWrite.agent.update({
      where: { id: agentId },
      data: { lastAlertAt: new Date() },
    });
  }

  // ── DCA Execution ────────────────────────────────────────────────────

  private async executeDCA(
    agent: Record<string, unknown>,
    config: DCAConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;
    const buysLeft = config.totalBuys - config.buysExecuted;
    if (buysLeft <= 0) {
      steps.push({
        stepIndex: ++stepIndex,
        description: 'All buys completed',
        input: { buysExecuted: config.buysExecuted, totalBuys: config.totalBuys },
        reasoning: 'DCA schedule complete - all buys have been executed',
        output: { action: 'none', reason: 'schedule_complete' },
        gasUsed: 100,
      });
      return { type: 'none', reason: 'schedule_complete' };
    }

    const now = new Date();
    const lastExecution = agent.lastExecutionAt
      ? new Date(agent.lastExecutionAt as string)
      : new Date(0);
    const minutesSinceLast = (now.getTime() - lastExecution.getTime()) / (1000 * 60);

    if (minutesSinceLast < config.frequencyMinutes) {
      const nextRun = new Date(lastExecution.getTime() + config.frequencyMinutes * 60 * 1000);
      steps.push({
        stepIndex: ++stepIndex,
        description: 'Waiting for next schedule',
        input: { minutesSinceLast, frequencyMinutes: config.frequencyMinutes },
        reasoning: `Next DCA buy scheduled at ${nextRun.toISOString()} (${Math.round(config.frequencyMinutes - minutesSinceLast)} minutes remaining)`,
        output: { action: 'none', reason: 'waiting', nextRun: nextRun.toISOString() },
        gasUsed: 100,
      });
      return { type: 'none', reason: 'waiting', nextRun: nextRun.toISOString() };
    }

    // Simulate price check - base price close to target if specified
    const basePrice = config.targetPrice ? Number(config.targetPrice) : 100;
    const currentPrice = basePrice + (Math.random() - 0.5) * basePrice * 0.02; // within ±1% of target
    const priceDeviation = config.targetPrice
      ? Math.abs((currentPrice - Number(config.targetPrice)) / Number(config.targetPrice)) * 100
      : 0;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Check current price',
      input: { pair: config.pair, targetPrice: config.targetPrice, currentPrice },
      reasoning: `Current price: ${currentPrice.toFixed(4)}${config.targetPrice ? `, deviation: ${priceDeviation.toFixed(2)}%` : ''}`,
      output: {
        price: currentPrice,
        deviation: priceDeviation,
        withinTolerance: priceDeviation < 1,
      },
      gasUsed: 5000,
    });

    if (priceDeviation >= 1 && config.targetPrice) {
      steps.push({
        stepIndex: ++stepIndex,
        description: 'Price deviation exceeds threshold',
        input: { deviation: priceDeviation, maxDeviation: 1 },
        reasoning: `Price deviation ${priceDeviation.toFixed(2)}% exceeds 1% threshold - skipping this buy cycle`,
        output: { action: 'skip', reason: 'price_deviation_exceeded' },
        gasUsed: 100,
      });
      return { type: 'swap', action: 'skip', reason: 'price_deviation_exceeded' };
    }

    // Execute buy
    const amount = config.amountPerBuy;
    steps.push({
      stepIndex: ++stepIndex,
      description: `Execute DCA buy ${config.buysExecuted + 1}/${config.totalBuys}`,
      input: { amount, pair: config.pair, slippage: config.maxSlippagePercent },
      reasoning: `Buy ${amount} of ${config.pair.tokenA} for ${currentPrice * Number(amount)} of ${config.pair.tokenB} at market rate with ${config.maxSlippagePercent}% max slippage`,
      output: { action: 'swap', executed: true },
      gasUsed: 45000,
    });

    // Update DCA config
    const updatedConfig = { ...config, buysExecuted: config.buysExecuted + 1 };
    await prismaWrite.agent.update({
      where: { id: agent.id as string },
      data: { config: updatedConfig as any },
    });

    return {
      type: 'swap',
      tokenIn: config.pair.tokenA,
      tokenOut: config.pair.tokenB,
      amount,
      expectedOut: (Number(amount) * currentPrice).toString(),
      slippage: config.maxSlippagePercent,
      reason: 'dca_execution',
    };
  }

  // ── Governance Execution ─────────────────────────────────────────────

  private async executeGovernance(
    agent: Record<string, unknown>,
    config: GovernanceConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    // Simulate fetching proposals
    const proposals = [
      { id: 'prop_001', title: 'Increase DEX Liquidity Incentives', support: 65, opposition: 35 },
      { id: 'prop_002', title: 'Upgrade Protocol Fee Structure', support: 45, opposition: 55 },
      { id: 'prop_003', title: 'Add New Collateral Type', support: 78, opposition: 22 },
    ];

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Fetch active proposals',
      input: { strategy: config.strategy },
      reasoning: `Found ${proposals.length} active proposals to evaluate using ${config.strategy} strategy`,
      output: { proposals: proposals.map((p) => p.id) },
      gasUsed: 5000,
    });

    const votes: Array<{ proposalId: string; vote: 'yes' | 'no' | 'abstain'; reasoning: string }> =
      [];

    for (const proposal of proposals) {
      let vote: 'yes' | 'no' | 'abstain';
      let reasoning: string;

      if (config.strategy === 'majority') {
        vote = proposal.support > proposal.opposition ? 'yes' : 'no';
        reasoning = `Voting with majority: ${proposal.support}% support`;
      } else if (config.strategy === 'specific_delegates') {
        vote = proposal.support > 50 ? 'yes' : 'no';
        reasoning = `Delegates signal ${proposal.support > 50 ? 'support' : 'opposition'}`;
      } else {
        // AI analysis simulation
        const hasPositiveKeywords = /increase|upgrade|add|improve/i.test(proposal.title);
        vote = hasPositiveKeywords ? 'yes' : 'no';
        reasoning = `AI analysis of "${proposal.title}" indicates ${hasPositiveKeywords ? 'positive' : 'negative'} impact`;
      }

      votes.push({ proposalId: proposal.id, vote, reasoning });

      steps.push({
        stepIndex: ++stepIndex,
        description: `Evaluate proposal: ${proposal.title}`,
        input: {
          proposalId: proposal.id,
          support: proposal.support,
          opposition: proposal.opposition,
        },
        reasoning,
        output: { vote, proposalId: proposal.id },
        gasUsed: 3000,
      });
    }

    const yesVotes = votes.filter((v) => v.vote === 'yes').length;
    const accuracy = config.strategy === 'majority' ? 100 : 95; // Simulated accuracy

    return {
      type: 'vote',
      votes: votes.map((v) => ({ proposalId: v.proposalId, vote: v.vote })),
      totalVotes: votes.length,
      yesVotes,
      noVotes: votes.filter((v) => v.vote === 'no').length,
      accuracy,
    };
  }

  // ── Yield Optimizer Execution ────────────────────────────────────────

  private async executeYieldOptimizer(
    agent: Record<string, unknown>,
    config: YieldOptimizerConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    // Simulate pool APY check
    const poolStates = config.pools.map((pool) => ({
      pool,
      currentApy: 5 + Math.random() * 15,
      totalDeposited: 100000 + Math.random() * 900000,
      rewardsPending: Math.random() * 1000 > 500,
    }));

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Check pool APYs',
      input: { pools: config.pools, targetApy: config.targetApy },
      reasoning: `Checked ${poolStates.length} pools. Best APY: ${Math.max(...poolStates.map((p) => p.currentApy)).toFixed(2)}%`,
      output: { poolStates: poolStates.map((p) => ({ pool: p.pool, apy: p.currentApy })) },
      gasUsed: 5000,
    });

    const actions: string[] = [];

    // Auto-compound check
    if (config.autoCompound) {
      const pendingRewards = poolStates.some((p) => p.rewardsPending);
      if (pendingRewards) {
        actions.push('compound');
        steps.push({
          stepIndex: ++stepIndex,
          description: 'Auto-compound rewards',
          input: { pools: config.pools },
          reasoning: 'Pending rewards detected - compounding to increase yield',
          output: { action: 'compound', pools: config.pools },
          gasUsed: 30000,
        });
      }
    }

    // Rebalance check
    for (const pool of poolStates) {
      if (pool.currentApy < config.targetApy - config.rebalanceThresholdPercent) {
        const targetPool = poolStates.reduce((best, p) =>
          p.currentApy > best.currentApy ? p : best,
        );
        actions.push(`rebalance_from_${pool.pool}_to_${targetPool.pool}`);
        steps.push({
          stepIndex: ++stepIndex,
          description: `Rebalance from ${pool.pool} to ${targetPool.pool}`,
          input: {
            fromPool: pool.pool,
            fromApy: pool.currentApy,
            toPool: targetPool.pool,
            toApy: targetPool.currentApy,
          },
          reasoning: `${pool.pool} APY (${pool.currentApy.toFixed(2)}%) is ${(config.targetApy - pool.currentApy).toFixed(2)}% below target - rebalancing to ${targetPool.pool} (${targetPool.currentApy.toFixed(2)}%)`,
          output: { action: 'rebalance', from: pool.pool, to: targetPool.pool },
          gasUsed: 45000,
        });
      }
    }

    return {
      type: 'yield_optimize',
      actions,
      poolsChecked: config.pools.length,
      compoundsExecuted: actions.filter((a) => a === 'compound').length,
      rebalancesExecuted: actions.filter((a) => a.startsWith('rebalance')).length,
    };
  }

  // ── MEV Protector Execution ──────────────────────────────────────────

  private async executeMevProtector(
    agent: Record<string, unknown>,
    config: MevProtectorConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Monitor mempool for pending transactions',
      input: { privateMempool: config.privateMempool, gasStrategy: config.gasStrategy },
      reasoning: `Using ${config.privateMempool ? 'private' : 'public'} mempool with ${config.gasStrategy} gas strategy`,
      output: { mempoolStatus: 'monitoring', pendingCount: 0 },
      gasUsed: 2000,
    });

    // Determine gas price based on strategy
    const gasMultipliers: Record<string, number> = {
      aggressive: 1.5,
      standard: 1.1,
      conservative: 1.0,
    };
    const gasMultiplier = gasMultipliers[config.gasStrategy] || 1.1;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Calculate optimal gas price',
      input: { strategy: config.gasStrategy, multiplier: gasMultiplier },
      reasoning: `Using ${config.gasStrategy} strategy with ${gasMultiplier}x multiplier to prevent frontrunning`,
      output: { gasMultiplier, effectiveGasPrice: gasMultiplier * 100 },
      gasUsed: 1000,
    });

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Wrap user transaction for MEV protection',
      input: { tipPercent: config.tipPercent },
      reasoning: `Transaction wrapped with ${config.tipPercent}% validator tip for priority inclusion via ${config.privateMempool ? 'private mempool' : 'Flashbots-style'}`,
      output: { action: 'wrap', wrapped: true, tipPercent: config.tipPercent },
      gasUsed: 35000,
    });

    return {
      type: 'wrap',
      wrapped: true,
      gasMultiplier,
      tipPercent: config.tipPercent,
      strategy: config.gasStrategy,
    };
  }

  // ── Stop-Loss Execution ──────────────────────────────────────────────

  private async executeStopLoss(
    agent: Record<string, unknown>,
    config: StopLossConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    // Simulate health check
    const currentHealth = 1.5 - Math.random() * 0.8;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Check position health',
      input: { position: config.positionContract, positionId: config.positionId },
      reasoning: `Current health factor: ${currentHealth.toFixed(3)}, threshold: ${config.healthThreshold}`,
      output: { healthFactor: currentHealth, threshold: config.healthThreshold },
      gasUsed: 5000,
    });

    if (currentHealth > config.healthThreshold) {
      steps.push({
        stepIndex: ++stepIndex,
        description: 'Position healthy - no action needed',
        input: { healthFactor: currentHealth, threshold: config.healthThreshold },
        reasoning: `Health factor ${currentHealth.toFixed(3)} above threshold ${config.healthThreshold} - position is safe`,
        output: { action: 'monitor', healthFactor: currentHealth },
        gasUsed: 100,
      });
      return { type: 'monitor', healthFactor: currentHealth, action: 'none' };
    }

    // Execute liquidation protection
    const amountToRepay = Math.floor(Math.random() * 1000) + 100;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Execute liquidation protection',
      input: { healthFactor: currentHealth, threshold: config.healthThreshold },
      reasoning: `Health factor ${currentHealth.toFixed(3)} below threshold ${config.healthThreshold} - executing swap to repay debt and protect position`,
      output: {
        action: 'swap',
        amountToRepay,
        targetToken: config.swapTargetToken,
        slippage: config.maxSlippagePercent,
      },
      gasUsed: 45000,
    });

    return {
      type: 'swap',
      action: 'repay',
      amount: amountToRepay.toString(),
      targetToken: config.swapTargetToken,
      slippage: config.maxSlippagePercent,
      reason: 'stop_loss_protection',
    };
  }

  // ── Liquidation Sniper Execution ─────────────────────────────────────

  private async executeLiquidationSniper(
    agent: Record<string, unknown>,
    config: LiquidationSniperConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Scan for undercollateralized positions',
      input: { pools: config.targetPools },
      reasoning: `Scanning ${config.targetPools.length} pools for positions below collateral threshold`,
      output: { poolsScanned: config.targetPools.length, candidatesFound: 0 },
      gasUsed: 5000,
    });

    const profitPercent = 0.5 + Math.random() * 3;

    if (profitPercent < config.minProfitPercent) {
      steps.push({
        stepIndex: ++stepIndex,
        description: 'No profitable liquidation targets',
        input: { minProfit: config.minProfitPercent, bestProfit: profitPercent },
        reasoning: `Best available profit ${profitPercent.toFixed(2)}% below minimum ${config.minProfitPercent}% - skipping`,
        output: { action: 'wait', bestProfit: profitPercent },
        gasUsed: 500,
      });
      return { type: 'none', action: 'wait', reason: 'insufficient_profit' };
    }

    const collateralAmount = Math.floor(Math.random() * 50000) + 10000;
    const debtAmount = Math.floor(collateralAmount * (1 - profitPercent / 100));

    steps.push({
      stepIndex: ++stepIndex,
      description: 'Execute liquidation',
      input: { profitPercent, minProfit: config.minProfitPercent },
      reasoning: `Profit ${profitPercent.toFixed(2)}% meets minimum ${config.minProfitPercent}% - liquidating position for ${collateralAmount} collateral at ${debtAmount} debt cost`,
      output: {
        action: 'liquidate',
        collateralAmount,
        debtAmount,
        profit: collateralAmount - debtAmount,
      },
      gasUsed: config.maxGasForTx,
    });

    return {
      type: 'liquidate',
      collateralAmount: collateralAmount.toString(),
      debtAmount: debtAmount.toString(),
      profit: (collateralAmount - debtAmount).toString(),
      profitPercent,
    };
  }

  // ── Compliance Execution ─────────────────────────────────────────────

  private async executeCompliance(
    agent: Record<string, unknown>,
    config: ComplianceConfig,
    steps: ExecutionStep[],
    startIndex: number,
  ): Promise<Record<string, unknown>> {
    let stepIndex = startIndex;

    for (const address of config.monitorAddresses) {
      const riskScore = Math.random() * 100;

      steps.push({
        stepIndex: ++stepIndex,
        description: `Screen address: ${address}`,
        input: { address, riskThreshold: config.riskThreshold },
        reasoning: `Risk score: ${riskScore.toFixed(1)}/100${riskScore > config.riskThreshold ? ' - EXCEEDS THRESHOLD' : ' - within limits'}`,
        output: { address, riskScore, flagged: riskScore > config.riskThreshold },
        gasUsed: 3000,
      });

      if (riskScore > config.riskThreshold && config.freezeOnAlert) {
        steps.push({
          stepIndex: ++stepIndex,
          description: `Freeze address: ${address}`,
          input: {
            riskScore,
            threshold: config.riskThreshold,
            freezeStrategy: config.freezeStrategy,
          },
          reasoning: `Risk score ${riskScore.toFixed(1)} exceeds ${config.riskThreshold} threshold - triggering freeze with ${config.freezeStrategy} strategy`,
          output: { action: 'freeze', address, strategy: config.freezeStrategy },
          gasUsed: 20000,
        });
      }
    }

    return {
      type: 'compliance_check',
      addressesChecked: config.monitorAddresses.length,
      flaggedAddresses: 0,
      actionsTaken: config.freezeOnAlert ? ['monitoring'] : [],
    };
  }
}

export const agentEngine = AgentEngine.getInstance();
