import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../db';
import type { AgentMessagePayload } from './types';
import { logger } from '../logger';

class AgentCommunicationBus {
  private static instance: AgentCommunicationBus;
  private messageHandlers: Map<string, Array<(msg: AgentMessagePayload) => Promise<void>>> =
    new Map();

  static getInstance(): AgentCommunicationBus {
    if (!AgentCommunicationBus.instance) {
      AgentCommunicationBus.instance = new AgentCommunicationBus();
    }
    return AgentCommunicationBus.instance;
  }

  on(type: string, handler: (msg: AgentMessagePayload) => Promise<void>): void {
    const handlers = this.messageHandlers.get(type) || [];
    handlers.push(handler);
    this.messageHandlers.set(type, handlers);
  }

  async sendMessage(params: {
    fromAgentId: string;
    toAgentId: string;
    type: AgentMessagePayload['type'];
    subject: string;
    body: Record<string, unknown>;
    responseToId?: string;
  }): Promise<string> {
    const messageId = crypto.randomUUID();
    const payload: AgentMessagePayload = {
      id: messageId,
      type: params.type,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      subject: params.subject,
      body: params.body,
      signature: '',
      timestamp: new Date().toISOString(),
    };

    payload.signature = this.signMessage(payload);

    await prismaWrite.agentMessage.create({
      data: {
        id: messageId,
        fromAgentId: params.fromAgentId,
        toAgentId: params.toAgentId,
        type: params.type,
        subject: params.subject,
        body: params.body as any,
        signature: payload.signature,
        responseToId: params.responseToId,
        status: 'pending',
      },
    });

    // Notify handlers
    const handlers = this.messageHandlers.get(params.type) || [];
    for (const handler of handlers) {
      handler(payload).catch((err) => {
        logger.error(`Message handler error for ${params.type}: ${err}`);
      });
    }

    logger.info(
      `Message sent: ${messageId} (${params.type}) from ${params.fromAgentId} to ${params.toAgentId}`,
    );
    return messageId;
  }

  async acknowledgeMessage(
    messageId: string,
    status: 'delivered' | 'acknowledged' | 'rejected',
  ): Promise<void> {
    await prismaWrite.agentMessage.update({
      where: { id: messageId },
      data: {
        status,
        respondedAt: new Date(),
      },
    });
  }

  async negotiate(params: {
    fromAgentId: string;
    toAgentId: string;
    serviceType: string;
    params: Record<string, unknown>;
    budget: string;
  }): Promise<{ accepted: boolean; messageId: string; counterOffer?: Record<string, unknown> }> {
    // Send initial request
    const messageId = await this.sendMessage({
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      type: 'request',
      subject: `Service request: ${params.serviceType}`,
      body: {
        serviceType: params.serviceType,
        params: params.params,
        budget: params.budget,
      },
    });

    // Simulate negotiation (in production, this would involve async callbacks)
    const autoAccept = Math.random() > 0.3; // 70% acceptance rate
    if (autoAccept) {
      await this.acknowledgeMessage(messageId, 'acknowledged');
      return { accepted: true, messageId };
    }

    // Send counter-offer
    const counterMessageId = await this.sendMessage({
      fromAgentId: params.toAgentId,
      toAgentId: params.fromAgentId,
      type: 'negotiate',
      subject: `Counter-offer: ${params.serviceType}`,
      body: {
        serviceType: params.serviceType,
        originalBudget: params.budget,
        counterBudget: (Number(params.budget) * 1.2).toString(),
        reason: 'Adjusted for current market conditions',
      },
      responseToId: messageId,
    });

    return {
      accepted: false,
      messageId: counterMessageId,
      counterOffer: {
        budget: (Number(params.budget) * 1.2).toString(),
        reason: 'Adjusted for current market conditions',
      },
    };
  }

  async getConversation(agentId1: string, agentId2: string, limit = 50) {
    return prismaRead.agentMessage.findMany({
      where: {
        OR: [
          { fromAgentId: agentId1, toAgentId: agentId2 },
          { fromAgentId: agentId2, toAgentId: agentId1 },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async getUnreadMessages(agentId: string) {
    return prismaRead.agentMessage.findMany({
      where: {
        toAgentId: agentId,
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private signMessage(msg: AgentMessagePayload): string {
    const content = `${msg.id}:${msg.fromAgentId}:${msg.toAgentId}:${msg.type}:${JSON.stringify(msg.body)}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  verifyMessageSignature(msg: AgentMessagePayload): boolean {
    if (!msg.signature) return false;
    const expectedSig = this.signMessage(msg);
    return msg.signature === expectedSig;
  }
}

// ── Discovery Registry ────────────────────────────────────────────────

class AgentDiscoveryRegistry {
  private static instance: AgentDiscoveryRegistry;

  static getInstance(): AgentDiscoveryRegistry {
    if (!AgentDiscoveryRegistry.instance) {
      AgentDiscoveryRegistry.instance = new AgentDiscoveryRegistry();
    }
    return AgentDiscoveryRegistry.instance;
  }

  async register(params: {
    agentId: string;
    capabilities: string[];
    pricePerCall?: string;
    pricePerMonth?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const existing = await prismaWrite.agentRegistration.findUnique({
      where: { agentId: params.agentId },
    });

    if (existing) {
      await prismaWrite.agentRegistration.update({
        where: { agentId: params.agentId },
        data: {
          capabilities: params.capabilities,
          pricePerCall: params.pricePerCall || existing.pricePerCall,
          pricePerMonth: params.pricePerMonth || existing.pricePerMonth,
          metadata: (params.metadata || {}) as any,
        },
      });
    } else {
      await prismaWrite.agentRegistration.create({
        data: {
          agentId: params.agentId,
          capabilities: params.capabilities,
          pricePerCall: params.pricePerCall,
          pricePerMonth: params.pricePerMonth,
          metadata: (params.metadata || {}) as any,
        },
      });
    }

    logger.info(
      `Agent ${params.agentId} registered capabilities: ${params.capabilities.join(', ')}`,
    );
  }

  async findProviders(
    capability: string,
    maxPrice?: string,
  ): Promise<
    Array<{
      agentId: string;
      capabilities: string[];
      pricePerCall: string | null;
      rating: number;
      totalJobsDone: number;
    }>
  > {
    const allRegistrations = await prismaRead.agentRegistration.findMany({
      where: { isActive: true },
      include: {
        agent: {
          select: { name: true, status: true },
        },
      },
    });

    return allRegistrations
      .filter((r) => {
        const caps = r.capabilities as string[];
        const hasCapability = caps.includes(capability);
        const isActive = r.agent.status === 'active' || r.agent.status === 'running';
        const withinBudget =
          !maxPrice || !r.pricePerCall || Number(r.pricePerCall) <= Number(maxPrice);
        return hasCapability && isActive && withinBudget;
      })
      .map((r) => ({
        agentId: r.agentId,
        capabilities: r.capabilities as string[],
        pricePerCall: r.pricePerCall?.toString() || null,
        rating: Number(r.rating),
        totalJobsDone: r.totalJobsDone,
      }))
      .sort((a, b) => b.rating - a.rating);
  }

  async unregister(agentId: string): Promise<void> {
    await prismaWrite.agentRegistration.update({
      where: { agentId },
      data: { isActive: false },
    });
  }
}

// ── Agent Reputation System ───────────────────────────────────────────

class AgentReputationSystem {
  private static instance: AgentReputationSystem;

  static getInstance(): AgentReputationSystem {
    if (!AgentReputationSystem.instance) {
      AgentReputationSystem.instance = new AgentReputationSystem();
    }
    return AgentReputationSystem.instance;
  }

  async submitRating(params: {
    fromAgentId: string;
    toAgentId: string;
    executionId?: string;
    score: number;
    review?: string;
  }): Promise<void> {
    if (params.score < 1 || params.score > 5) {
      throw new Error('Rating score must be between 1 and 5');
    }

    await prismaWrite.agentRating.create({
      data: {
        fromAgentId: params.fromAgentId,
        toAgentId: params.toAgentId,
        executionId: params.executionId,
        score: params.score,
        review: params.review,
      },
    });

    // Update aggregate rating
    const ratings = await prismaRead.agentRating.findMany({
      where: { toAgentId: params.toAgentId },
      select: { score: true },
    });

    const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;

    await prismaWrite.agentRegistration.updateMany({
      where: { agentId: params.toAgentId },
      data: {
        rating: Math.round(avgRating * 100) / 100,
        totalRatings: ratings.length,
      },
    });

    // Also increment jobs done if there's an execution
    if (params.executionId) {
      await prismaWrite.agentRegistration.updateMany({
        where: { agentId: params.toAgentId },
        data: { totalJobsDone: { increment: 1 } },
      });
    }
  }

  async getAgentRating(agentId: string): Promise<{
    averageScore: number;
    totalRatings: number;
    recentRatings: Array<{ score: number; review: string | null; createdAt: Date }>;
  }> {
    const ratings = await prismaRead.agentRating.findMany({
      where: { toAgentId: agentId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const avg =
      ratings.length > 0 ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length : 0;

    return {
      averageScore: Math.round(avg * 100) / 100,
      totalRatings: ratings.length,
      recentRatings: ratings.map((r) => ({
        score: r.score,
        review: r.review,
        createdAt: r.createdAt,
      })),
    };
  }
}

export const communicationBus = AgentCommunicationBus.getInstance();
export const discoveryRegistry = AgentDiscoveryRegistry.getInstance();
export const agentReputation = AgentReputationSystem.getInstance();
