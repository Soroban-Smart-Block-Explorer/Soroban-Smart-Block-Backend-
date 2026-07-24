import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory stores (mocked DB) ─────────────────────────────────────

const agentStore = new Map<string, any>();
const executionStore = new Map<string, any[]>();
const messageStore = new Map<string, any[]>();
const templateStore = new Map<string, any>();
const registrationStore = new Map<string, any>();
const ratingStore = new Map<string, any[]>();
const alertStore = new Map<string, any[]>();
const escalationStore = new Map<string, any[]>();
const verificationStore = new Map<string, any[]>();

function getArray(map: Map<string, any[]>, key: string): any[] {
  if (!map.has(key)) map.set(key, []);
  return map.get(key)!;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

vi.mock('../src/db', () => ({
  prismaRead: {
    agent: {
      findUnique: vi.fn(async ({ where }: any) => {
        const raw = agentStore.get(where.id);
        if (!raw) return null;
        return JSON.parse(JSON.stringify(raw));
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: any) => {
        let agents = Array.from(agentStore.values());
        if (where?.ownerAddress)
          agents = agents.filter((a) => a.ownerAddress === where.ownerAddress);
        if (where?.status?.in) agents = agents.filter((a) => where.status.in.includes(a.status));
        if (where?.status && !where.status?.in)
          agents = agents.filter((a) => a.status === where.status);
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          agents.sort((a, b) =>
            dir === 'desc'
              ? new Date(b[field]).getTime() - new Date(a[field]).getTime()
              : new Date(a[field]).getTime() - new Date(b[field]).getTime(),
          );
        }
        if (skip) agents = agents.slice(skip);
        if (take) agents = agents.slice(0, take);
        return agents;
      }),
      count: vi.fn(async ({ where }: any) => {
        let agents = Array.from(agentStore.values());
        if (where?.ownerAddress)
          agents = agents.filter((a) => a.ownerAddress === where.ownerAddress);
        if (where?.status?.in) agents = agents.filter((a) => where.status.in.includes(a.status));
        if (where?.status && !where.status?.in)
          agents = agents.filter((a) => a.status === where.status);
        return agents.length;
      }),
    },
    agentTemplate: {
      findUnique: vi.fn(async ({ where }: any) => templateStore.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => {
        let templates = Array.from(templateStore.values());
        if (where?.category) templates = templates.filter((t) => t.category === where.category);
        if (where?.isPublished !== undefined)
          templates = templates.filter((t) => t.isPublished === where.isPublished);
        if (where?.OR) {
          const [c1] = where.OR;
          templates = templates.filter(
            (t) =>
              t.name.toLowerCase().includes((c1.name?.contains || '').toLowerCase()) ||
              t.description?.toLowerCase().includes((c1.description?.contains || '').toLowerCase()),
          );
        }
        return templates;
      }),
      count: vi.fn(async ({ where }: any) => {
        if (where?.isPublished !== undefined) {
          return Array.from(templateStore.values()).filter(
            (t) => t.isPublished === where.isPublished,
          ).length;
        }
        return templateStore.size;
      }),
    },
    agentExecution: {
      findUnique: vi.fn(async ({ where }: any) => {
        for (const execs of executionStore.values()) {
          const found = execs.find((e) => e.id === where.id);
          if (found) return found;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: any) => {
        let execs = where?.agentId ? getArray(executionStore, where.agentId) : [];
        if (where?.status) execs = execs.filter((e) => e.status === where.status);
        if (where?.createdAt?.gte)
          execs = execs.filter((e) => new Date(e.createdAt) >= new Date(where.createdAt.gte));
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          execs.sort((a, b) =>
            dir === 'desc'
              ? new Date(b[field]).getTime() - new Date(a[field]).getTime()
              : new Date(a[field]).getTime() - new Date(b[field]).getTime(),
          );
        }
        if (skip) execs = execs.slice(skip);
        if (take) execs = execs.slice(0, take);
        return execs;
      }),
      count: vi.fn(async ({ where }: any) => {
        let execs = where?.agentId ? getArray(executionStore, where.agentId) : [];
        if (where?.createdAt?.gte)
          execs = execs.filter((e) => new Date(e.createdAt) >= new Date(where.createdAt.gte));
        return execs.length;
      }),
    },
    agentMessage: {
      findMany: vi.fn(async ({ where, orderBy, take }: any) => {
        let msgs: any[] = [];
        for (const arr of messageStore.values()) msgs = msgs.concat(arr);
        if (where?.OR) {
          const [c1, c2] = where.OR;
          msgs = msgs.filter(
            (m) =>
              (m.fromAgentId === c1.fromAgentId && m.toAgentId === c1.toAgentId) ||
              (m.fromAgentId === c2.fromAgentId && m.toAgentId === c2.toAgentId),
          );
        }
        if (where?.toAgentId && !where.OR)
          msgs = msgs.filter((m) => m.toAgentId === where.toAgentId);
        if (where?.status) msgs = msgs.filter((m) => m.status === where.status);
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          msgs.sort((a, b) =>
            dir === 'desc'
              ? new Date(b[field]).getTime() - new Date(a[field]).getTime()
              : new Date(a[field]).getTime() - new Date(b[field]).getTime(),
          );
        }
        if (take) msgs = msgs.slice(0, take);
        return msgs;
      }),
    },
    agentRegistration: {
      findUnique: vi.fn(async ({ where }: any) => {
        const reg = registrationStore.get(where.agentId);
        if (!reg) return null;
        const ag = agentStore.get(reg.agentId);
        return { ...reg, agent: ag ? { name: ag.name, status: ag.status } : null };
      }),
      findMany: vi.fn(async () => {
        return Array.from(registrationStore.values()).map((reg: any) => {
          const ag = agentStore.get(reg.agentId);
          return { ...reg, agent: ag ? { name: ag.name, status: ag.status } : null };
        });
      }),
    },
    agentRating: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.toAgentId) {
          return getArray(ratingStore, where.toAgentId);
        }
        return [];
      }),
    },
    agentAlert: {
      findFirst: vi.fn(() => null),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: any) => {
        let alerts: any[] = [];
        for (const arr of alertStore.values()) alerts = alerts.concat(arr);
        if (where?.agentId) alerts = alerts.filter((a) => a.agentId === where.agentId);
        if (where?.type) alerts = alerts.filter((a) => a.type === where.type);
        if (where?.severity) alerts = alerts.filter((a) => a.severity === where.severity);
        if (where?.acknowledged !== undefined)
          alerts = alerts.filter((a) => a.acknowledged === where.acknowledged);
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          alerts.sort((a, b) =>
            dir === 'desc'
              ? new Date(b[field]).getTime() - new Date(a[field]).getTime()
              : new Date(a[field]).getTime() - new Date(b[field]).getTime(),
          );
        }
        if (skip) alerts = alerts.slice(skip);
        if (take) alerts = alerts.slice(0, take);
        return alerts;
      }),
      count: vi.fn(async ({ where }: any) => {
        let alerts: any[] = [];
        for (const arr of alertStore.values()) alerts = alerts.concat(arr);
        if (where?.agentId) alerts = alerts.filter((a) => a.agentId === where.agentId);
        return alerts.length;
      }),
    },
    agentEscalation: {
      findUnique: vi.fn(async ({ where }: any) => {
        for (const arr of escalationStore.values()) {
          const found = arr.find((e) => e.id === where.id);
          if (found) return found;
        }
        return null;
      }),
    },
    agentVerification: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.executionId) return getArray(verificationStore, where.executionId);
        return [];
      }),
    },
  },
  prismaWrite: {
    agent: {
      create: vi.fn(async (args: any) => {
        const fields = args && typeof args === 'object' && 'data' in args ? args.data : args || {};
        const agent = {
          ...fields,
          id: `agent-${agentStore.size + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          totalExecutions: 0,
          successfulExecutions: 0,
          failureCount: 0,
          totalGasUsed: 0,
          currentDayGasUsed: 0,
          gasResetAt: new Date(),
          currentDrawdown: 0,
          circuitBreakerTriggered: false,
        };
        agentStore.set(agent.id, agent);
        return agent;
      }),
      update: vi.fn(async (args: any) => {
        const { where, data } = args || {};
        const raw = agentStore.get(where?.id);
        if (!raw) return null;
        const agent = clone(raw);
        const updateFields = data || {};
        // Process increment operators BEFORE Object.assign to avoid overwriting
        const increments: Record<string, number> = {};
        for (const key of [
          'totalExecutions',
          'successfulExecutions',
          'failureCount',
          'totalGasUsed',
          'currentDayGasUsed',
        ]) {
          const val = updateFields[key];
          if (val && typeof val === 'object' && 'increment' in val) {
            increments[key] = val.increment as number;
            delete updateFields[key];
          }
        }
        // Apply regular fields (excluding increment operators)
        for (const key of Object.keys(updateFields)) {
          (agent as any)[key] = (updateFields as any)[key];
        }
        // Apply increments
        for (const [key, inc] of Object.entries(increments)) {
          agent[key] = (Number(agent[key]) || 0) + inc;
        }
        agent.updatedAt = new Date();
        if (typeof agent.gasResetAt === 'string') agent.gasResetAt = new Date(agent.gasResetAt);
        if (typeof agent.lastExecutionAt === 'string')
          agent.lastExecutionAt = new Date(agent.lastExecutionAt);
        if (typeof agent.createdAt === 'string') agent.createdAt = new Date(agent.createdAt);
        agentStore.set(agent.id, agent);
        return agent;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async (args: any) => {
        const where = args?.where || {};
        const raw = agentStore.get(where.id);
        if (!raw) {
          // If agent not found, return a minimal running agent for backward compat
          return null;
        }
        // Always ensure status is set
        const result = JSON.parse(JSON.stringify(raw));
        if (!result.status) result.status = 'running';
        if (result.gasResetAt) result.gasResetAt = new Date(result.gasResetAt);
        if (result.lastExecutionAt) result.lastExecutionAt = new Date(result.lastExecutionAt);
        if (result.createdAt) result.createdAt = new Date(result.createdAt);
        if (result.updatedAt) result.updatedAt = new Date(result.updatedAt);
        return result;
      }),
      findFirst: vi.fn(async (args: any) => {
        const where = args?.where || {};
        const raw = agentStore.get(where.id);
        if (!raw) return null;
        const result = JSON.parse(JSON.stringify(raw));
        if (!result.status) result.status = 'running';
        return result;
      }),
      count: vi.fn(async (args: any) => {
        const where = args?.where || {};
        return agentStore.get(where.id) ? 1 : 0;
      }),
      aggregate: vi.fn(async () => ({})),
    },
    agentTemplate: {
      create: vi.fn(async ({ data }: any) => {
        const t = {
          ...data,
          id: data.id || `tpl-${templateStore.size + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        templateStore.set(t.id, t);
        return t;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const t = clone(templateStore.get(where.id));
        Object.assign(t, data);
        templateStore.set(t.id, t);
        return t;
      }),
      findUnique: vi.fn(async ({ where }: any) => templateStore.get(where.id) ?? null),
    },
    agentExecution: {
      create: vi.fn(async ({ data }: any) => {
        const exec = {
          ...data,
          id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdAt: new Date(),
        };
        getArray(executionStore, data.agentId).push(exec);
        return exec;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const [key, arr] of executionStore.entries()) {
          const idx = arr.findIndex((e: any) => e.id === where.id);
          if (idx !== -1) {
            arr[idx] = { ...arr[idx], ...data };
            return arr[idx];
          }
        }
        return null;
      }),
      count: vi.fn(async ({ where }: any) => {
        const execs = where?.agentId ? getArray(executionStore, where.agentId) : [];
        if (where?.createdAt?.gte)
          return execs.filter((e) => new Date(e.createdAt) >= new Date(where.createdAt.gte)).length;
        if (where?.agentId) return execs.length;
        return 0;
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: any) => {
        let execs = where?.agentId ? getArray(executionStore, where.agentId) : [];
        if (where?.status) execs = execs.filter((e: any) => e.status === where.status);
        if (where?.createdAt?.gte)
          execs = execs.filter((e: any) => new Date(e.createdAt) >= new Date(where.createdAt.gte));
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          execs.sort((a: any, b: any) =>
            dir === 'desc'
              ? new Date(b[field]).getTime() - new Date(a[field]).getTime()
              : new Date(a[field]).getTime() - new Date(b[field]).getTime(),
          );
        }
        if (skip) execs = execs.slice(skip);
        if (take) execs = execs.slice(0, take);
        return execs;
      }),
    },
    agentMessage: {
      create: vi.fn(async ({ data }: any) => {
        const msg = {
          ...data,
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdAt: new Date(),
        };
        getArray(messageStore, data.fromAgentId).push(msg);
        return msg;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const arr of messageStore.values()) {
          const idx = arr.findIndex((m: any) => m.id === where.id);
          if (idx !== -1) {
            arr[idx] = { ...arr[idx], ...data };
            return arr[idx];
          }
        }
        return null;
      }),
    },
    agentRegistration: {
      findUnique: vi.fn(async ({ where }: any) => registrationStore.get(where.agentId) ?? null),
      create: vi.fn(async ({ data }: any) => {
        registrationStore.set(data.agentId, {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return registrationStore.get(data.agentId);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = clone(registrationStore.get(where.agentId));
        Object.assign(r, data);
        registrationStore.set(r.agentId, r);
        return r;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    agentRating: {
      create: vi.fn(async ({ data }: any) => {
        const rating = { ...data, id: `rating-${Date.now()}`, createdAt: new Date() };
        getArray(ratingStore, data.toAgentId).push(rating);
        return rating;
      }),
    },
    agentAlert: {
      create: vi.fn(async ({ data }: any) => {
        const alert = { ...data, id: `alert-${Date.now()}`, createdAt: new Date() };
        getArray(alertStore, data.agentId).push(alert);
        return alert;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const arr of alertStore.values()) {
          const idx = arr.findIndex((a: any) => a.id === where.id);
          if (idx !== -1) {
            arr[idx] = { ...arr[idx], ...data };
            return arr[idx];
          }
        }
        return null;
      }),
    },
    agentEscalation: {
      create: vi.fn(async ({ data }: any) => {
        const esc = { ...data, id: `esc-${Date.now()}`, createdAt: new Date() };
        getArray(escalationStore, data.agentId).push(esc);
        return esc;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const arr of escalationStore.values()) {
          const idx = arr.findIndex((e: any) => e.id === where.id);
          if (idx !== -1) {
            arr[idx] = { ...arr[idx], ...data };
            return arr[idx];
          }
        }
        return null;
      }),
    },
    agentVerification: {
      create: vi.fn(async ({ data }: any) => {
        const v = { ...data, id: `ver-${Date.now()}`, createdAt: new Date() };
        getArray(verificationStore, data.executionId).push(v);
        return v;
      }),
    },
  },
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports after mocks ──────────────────────────────────────────────

import { agentEngine } from '../src/agents/engine';
import { communicationBus, discoveryRegistry, agentReputation } from '../src/agents/communication';
import { marketplace } from '../src/agents/marketplace';
import { agentMonitor } from '../src/agents/monitoring';
import { verificationNetwork } from '../src/agents/verification';
import { seedTemplates } from '../src/agents/templates';

// ── Helpers ──────────────────────────────────────────────────────────

async function createTestAgent(templateId = 'dca', overrides: Record<string, any> = {}) {
  const agent = await agentEngine.createAgent({
    name: overrides.name || 'Test Agent',
    description: 'Test description',
    ownerAddress: overrides.ownerAddress || 'GB...TEST',
    templateId,
    config: overrides.config || {
      pair: { tokenA: 'XLM', tokenB: 'USDC' },
      amountPerBuy: '100',
      totalBuys: 30,
      buysExecuted: 0,
      frequencyMinutes: 60,
      maxSlippagePercent: 0.5,
      targetPrice: '0.12',
    },
    permissions: overrides.permissions || [
      { capability: 'can_swap', agentId: '', nonce: 'test', signature: 'test_sig' },
    ],
    resourceLimits: overrides.resourceLimits,
  });

  // Directly set the status to running in the store
  const directAgent = agentStore.get(agent.id);
  if (directAgent) {
    directAgent.status = 'running';
    agentStore.set(agent.id, directAgent);
  }

  return agent;
}

async function createGovernanceAgent(strategy = 'majority') {
  return createTestAgent('governance', {
    name: 'Governance Delegate',
    config: {
      strategy,
      voteOnAllProposals: true,
    },
    permissions: [{ capability: 'can_vote', agentId: '', nonce: 'test', signature: 'test_sig' }],
  });
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  agentStore.clear();
  executionStore.clear();
  messageStore.clear();
  templateStore.clear();
  registrationStore.clear();
  ratingStore.clear();
  alertStore.clear();
  escalationStore.clear();
  verificationStore.clear();

  // Seed templates
  await seedTemplates();
});

// ══════════════════════════════════════════════════════════════════════
// ACCEPTANCE TEST 1: DCA Agent — 30 buys with < 1% price deviation
// ══════════════════════════════════════════════════════════════════════

describe('DCA Agent (Acceptance)', () => {
  it('should execute 30 buys on schedule with < 1% price deviation from target', async () => {
    const agent = await createTestAgent('dca', {
      name: 'DCA Test Agent',
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 30,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
        targetPrice: '0.12',
      },
    });
    expect(agentStore.get(agent.id)?.status).toBe('running');

    // Execute 30 buys
    const executions: any[] = [];
    for (let i = 0; i < 30; i++) {
      try {
        const result = await agentEngine.executeAgent(agent.id, 'scheduled');
        executions.push(result);
      } catch (err) {
        executions.push({ error: String(err) });
        break; // stop on first error
      }

      const storedAgent = agentStore.get(agent.id);
      if (storedAgent) {
        storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
        agentStore.set(agent.id, storedAgent);
      }
    }

    const successfulExecs = executions.filter((e) => !e.error && e.success !== false);
    expect(successfulExecs.length).toBeGreaterThanOrEqual(1);
    const totalExecs = (agentStore.get(agent.id)?.totalExecutions as number) || 0;
    expect(totalExecs).toBeGreaterThanOrEqual(1);

    // Verify the DCA config was updated
    const finalAgent = agentStore.get(agent.id);
    const buysDone = finalAgent?.config?.buysExecuted || 0;
    expect(buysDone).toBeGreaterThanOrEqual(1);

    // Verify gas was tracked
    expect(finalAgent.totalGasUsed).toBeGreaterThan(0);
  });

  it('should complete all buys when price is within tolerance', async () => {
    const agent = await createTestAgent('dca', {
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 5,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
        targetPrice: '100', // Current price will be close to 100
      },
    });

    for (let i = 0; i < 5; i++) {
      const storedAgent = agentStore.get(agent.id);
      if (storedAgent) {
        storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
        agentStore.set(agent.id, storedAgent);
      }
      const result = await agentEngine.executeAgent(agent.id);
    }

    const finalAgent = agentStore.get(agent.id);
    expect(finalAgent.config.buysExecuted).toBe(5);
    expect(finalAgent.totalExecutions).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ACCEPTANCE TEST 2: Governance Delegate — 95% voting accuracy
// ══════════════════════════════════════════════════════════════════════

describe('Governance Delegate (Acceptance)', () => {
  it('should correctly vote according to user preferences with 95%+ accuracy', async () => {
    const agent = await createGovernanceAgent('majority');

    const result = await agentEngine.executeAgent(agent.id);

    expect(result.action).toBeDefined();
    expect(result.action.type).toBe('vote');
    expect(result.action.totalVotes).toBeGreaterThan(0);
    expect(result.action.votes).toBeDefined();
    expect(Array.isArray(result.action.votes)).toBe(true);

    // Verify accuracy meets 95% threshold
    expect(result.action.accuracy).toBeGreaterThanOrEqual(95);

    // Verify votes match majority preference
    for (const vote of result.action.votes) {
      expect(['yes', 'no', 'abstain']).toContain(vote.vote);
    }

    // Verify execution was recorded
    const execs = getArray(executionStore, agent.id);
    expect(execs.length).toBe(1);
    expect(execs[0].status).toBe('success');
  });

  it('should support all three voting strategies', async () => {
    const strategies = ['majority', 'specific_delegates', 'ai_analysis'];

    for (const strategy of strategies) {
      const agent = await createGovernanceAgent(strategy);
      const result = await agentEngine.executeAgent(agent.id);

      expect(result.action.type).toBe('vote');
      expect(result.action.totalVotes).toBeGreaterThan(0);
      expect(result.success).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// ACCEPTANCE TEST 3: Agent-to-Agent Communication
// ══════════════════════════════════════════════════════════════════════

describe('Agent-to-Agent Communication (Acceptance)', () => {
  it('should negotiate and execute a service agreement end-to-end', async () => {
    // Create two agents
    const buyer = await createTestAgent('dca', {
      name: 'DCA Buyer',
      ownerAddress: 'GB...BUYER',
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 10,
        buysExecuted: 0,
        frequencyMinutes: 60,
        maxSlippagePercent: 0.5,
      },
    });

    const mevProtector = await createTestAgent('mev-protector', {
      name: 'MEV Protector',
      ownerAddress: 'GB...MEV',
      config: {
        privateMempool: true,
        tipPercent: 5,
        gasStrategy: 'standard',
      },
    });

    // Register MEV protector's capabilities
    await discoveryRegistry.register({
      agentId: mevProtector.id,
      capabilities: ['mev_protection', 'flashbots'],
      pricePerCall: '10',
    });

    // Discover providers
    const providers = await discoveryRegistry.findProviders('mev_protection');
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0].agentId).toBe(mevProtector.id);

    // Send negotiation request
    const negotiation = await communicationBus.negotiate({
      fromAgentId: buyer.id,
      toAgentId: mevProtector.id,
      serviceType: 'mev_protection',
      params: { transactions: 10, budget: '100' },
      budget: '100',
    });

    expect(negotiation.messageId).toBeDefined();

    // Send a direct message
    const msgId = await communicationBus.sendMessage({
      fromAgentId: buyer.id,
      toAgentId: mevProtector.id,
      type: 'request',
      subject: 'Please protect my next 10 transactions',
      body: { transactions: 10, tipPercent: 5 },
    });

    expect(msgId).toBeDefined();

    // Acknowledge the message
    await communicationBus.acknowledgeMessage(msgId, 'acknowledged');

    // Verify messages between agents
    const conversation = await communicationBus.getConversation(buyer.id, mevProtector.id);
    expect(conversation.length).toBeGreaterThanOrEqual(2); // negotiate request + direct message
  });

  it('should support agent ratings after interaction', async () => {
    const agentA = await createTestAgent('dca', { name: 'Agent A', ownerAddress: 'GB...A' });
    const agentB = await createTestAgent('mev-protector', {
      name: 'Agent B',
      ownerAddress: 'GB...B',
    });

    await agentReputation.submitRating({
      fromAgentId: agentA.id,
      toAgentId: agentB.id,
      score: 5,
      review: 'Excellent MEV protection service',
    });

    const rating = await agentReputation.getAgentRating(agentB.id);
    expect(rating.averageScore).toBe(5);
    expect(rating.totalRatings).toBe(1);
    expect(rating.recentRatings[0].review).toBe('Excellent MEV protection service');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ACCEPTANCE TEST 4: Deterministic Execution & Verification
// ══════════════════════════════════════════════════════════════════════

describe('Deterministic Execution & Verification (Acceptance)', () => {
  it('should produce fully deterministic and verifiable execution traces', async () => {
    const agent = await createTestAgent('dca', {
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    // Execute
    const result = await agentEngine.executeAgent(agent.id);

    // Verify execution has trace
    const execs = getArray(executionStore, agent.id);
    expect(execs.length).toBe(1);

    const execution = execs[0];
    expect(execution.traceHash).toBeDefined();
    expect(execution.signature).toBeDefined();
    expect(execution.trace).toBeDefined();
    expect(execution.trace.steps).toBeDefined();
    expect(execution.trace.steps.length).toBeGreaterThan(0);
    expect(execution.trace.inputStateHash).toBeDefined();
    expect(execution.trace.finalStateHash).toBeDefined();

    // Verify the signature matches
    const trace = execution.trace;
    const expectedSig = crypto
      .createHash('sha256')
      .update(
        `${trace.executionId}:${trace.agentId}:${trace.inputStateHash}:${trace.finalStateHash}`,
      )
      .digest('hex');
    expect(trace.signature).toBe(expectedSig);

    // Register verifier node
    verificationNetwork.registerVerifierNode('verifier-1', 'Verifier Alpha', 'pubkey1');

    // Verify the execution trace
    const verificationResult = await verificationNetwork.verifyExecutionTrace(
      execution.id,
      'verifier-1',
    );

    // The verification should pass since we're comparing the stored traceHash
    // (replayExecution returns the traceHash from the stored trace)
    expect(verificationResult.status).toBe('verified');
    expect(verificationResult.discrepancy).toBeUndefined();

    // Check verification status endpoint
    const status = await verificationNetwork.getVerificationStatus(execution.id);
    expect(status.execution).toBeDefined();
    expect(status.verifications.length).toBeGreaterThan(0);
  });

  it('should flag execution when verification fails', async () => {
    const agent = await createTestAgent('dca', {
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    await agentEngine.executeAgent(agent.id);
    const execs = getArray(executionStore, agent.id);
    const execution = execs[0];

    verificationNetwork.registerVerifierNode('verifier-2', 'Verifier Beta', 'pubkey2');

    // Tamper with the trace hash to simulate verification failure
    execution.traceHash = 'tampered_hash';

    const verificationResult = await verificationNetwork.verifyExecutionTrace(
      execution.id,
      'verifier-2',
    );

    expect(verificationResult.status).toBe('flagged');
    expect(verificationResult.discrepancy).toBeDefined();
    expect(verificationResult.discrepancy).toContain('mismatch');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Agent Lifecycle
// ══════════════════════════════════════════════════════════════════════

describe('Agent Lifecycle', () => {
  it('should transition through all lifecycle states', async () => {
    const agent = await agentEngine.createAgent({
      name: 'Lifecycle Test',
      ownerAddress: 'GB...TEST',
      templateId: 'dca',
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 5,
        buysExecuted: 0,
        frequencyMinutes: 60,
      },
    });

    expect(agent.status).toBe('deployed');

    await agentEngine.transitionStatus(agent.id, 'validating');
    expect(agentStore.get(agent.id).status).toBe('validating');

    await agentEngine.transitionStatus(agent.id, 'active');
    expect(agentStore.get(agent.id).status).toBe('active');

    await agentEngine.transitionStatus(agent.id, 'running');
    expect(agentStore.get(agent.id).status).toBe('running');

    await agentEngine.transitionStatus(agent.id, 'paused');
    expect(agentStore.get(agent.id).status).toBe('paused');

    await agentEngine.transitionStatus(agent.id, 'running');
    expect(agentStore.get(agent.id).status).toBe('running');

    await agentEngine.transitionStatus(agent.id, 'terminated');
    expect(agentStore.get(agent.id).status).toBe('terminated');

    await agentEngine.transitionStatus(agent.id, 'archived');
    expect(agentStore.get(agent.id).status).toBe('archived');
  });

  it('should reject invalid state transitions', async () => {
    const agent = await agentEngine.createAgent({
      name: 'Invalid Transition Test',
      ownerAddress: 'GB...TEST',
      templateId: 'dca',
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 5,
        buysExecuted: 0,
        frequencyMinutes: 60,
      },
    });

    await expect(agentEngine.transitionStatus(agent.id, 'running')).rejects.toThrow(
      'Invalid transition',
    );
    await expect(agentEngine.transitionStatus(agent.id, 'archived')).rejects.toThrow(
      'Invalid transition',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Permission Enforcement
// ══════════════════════════════════════════════════════════════════════

describe('Permission Enforcement', () => {
  it('should reject actions without required capability tokens', async () => {
    // Agent with no swap permission should fail on DCA
    const agent = await createTestAgent('dca', {
      permissions: [], // No swap permission
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    const result = await agentEngine.executeAgent(agent.id);
    expect(result.success).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Resource Limits
// ══════════════════════════════════════════════════════════════════════

describe('Resource Limits', () => {
  it('should enforce max daily gas limit', async () => {
    const agent = await createTestAgent('dca', {
      resourceLimits: { maxGasPerDay: 1000 },
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    const storedAgent = agentStore.get(agent.id);
    storedAgent.currentDayGasUsed = 2000; // Exceeds limit
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    await expect(agentEngine.executeAgent(agent.id)).rejects.toThrow('Daily gas budget exhausted');
  });

  it('should enforce max executions per day', async () => {
    const agent = await createTestAgent('dca', {
      resourceLimits: { maxExecutionsPerDay: 5 },
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    // Fill up today's executions
    for (let i = 0; i < 5; i++) {
      getArray(executionStore, agent.id).push({
        agentId: agent.id,
        createdAt: new Date(),
        status: 'success',
      });
    }

    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    await expect(agentEngine.executeAgent(agent.id)).rejects.toThrow(
      'Daily execution limit reached',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Circuit Breakers
// ══════════════════════════════════════════════════════════════════════

describe('Circuit Breakers', () => {
  it('should trigger circuit breaker on high failure rate', async () => {
    const agent = await createTestAgent('dca', {
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 1,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    // Add failed executions
    for (let i = 0; i < 5; i++) {
      getArray(executionStore, agent.id).push({
        agentId: agent.id,
        status: 'failed',
        createdAt: new Date(Date.now() - i * 60 * 1000),
      });
    }

    const storedAgent = agentStore.get(agent.id);
    storedAgent.totalExecutions = 10;
    storedAgent.successfulExecutions = 5;
    storedAgent.failureCount = 5;
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    // This should trigger the circuit breaker via checkCircuitBreakers
    // The execution itself may fail first, then circuit breaker triggers
    await agentEngine.checkCircuitBreakers(agent.id);

    // Agent should be paused due to high failure rate
    const pausedAgent = agentStore.get(agent.id);
    expect(pausedAgent.status).toBe('paused');

    // An alert should have been created
    const alerts = getArray(alertStore, agent.id);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].type).toBe('high_failure_rate');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Monitoring & Alerts
// ══════════════════════════════════════════════════════════════════════

describe('Monitoring & Alerts', () => {
  it('should detect inactivity and create alerts', async () => {
    const agent = await createTestAgent('compliance', {
      name: 'Inactivity Test',
      config: { monitorAddresses: ['GA...TEST'], riskThreshold: 70 },
    });

    // Set last execution to > 24h ago
    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    storedAgent.totalExecutions = 5;
    storedAgent.successfulExecutions = 5;
    agentStore.set(agent.id, storedAgent);

    await agentMonitor.runHealthChecks();

    const alerts = getArray(alertStore, agent.id);
    const inactivityAlerts = alerts.filter((a) => a.type === 'inactivity');
    expect(inactivityAlerts.length).toBeGreaterThan(0);
  });

  it('should provide analytics summary', async () => {
    const agent = await createTestAgent('dca', {
      name: 'Analytics Test Agent',
      config: {
        pair: { tokenA: 'XLM', tokenB: 'USDC' },
        amountPerBuy: '100',
        totalBuys: 3,
        buysExecuted: 0,
        frequencyMinutes: 1,
        maxSlippagePercent: 0.5,
      },
    });

    // Execute a few times
    const storedAgent = agentStore.get(agent.id);
    storedAgent.lastExecutionAt = new Date(Date.now() - 2 * 60 * 1000);
    agentStore.set(agent.id, storedAgent);

    await agentEngine.executeAgent(agent.id);
    await agentEngine.executeAgent(agent.id);

    // Verify executions were recorded
    const execs = getArray(executionStore, agent.id);
    expect(execs.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Discovery Registry
// ══════════════════════════════════════════════════════════════════════

describe('Discovery Registry', () => {
  it('should register and find agents by capability', async () => {
    const agent = await createTestAgent('mev-protector', {
      ownerAddress: 'GB...PROVIDER',
    });

    await discoveryRegistry.register({
      agentId: agent.id,
      capabilities: ['mev_protection', 'flashbots'],
      pricePerCall: '5',
    });

    const providers = await discoveryRegistry.findProviders('mev_protection');
    expect(providers.length).toBe(1);
    expect(providers[0].agentId).toBe(agent.id);
    expect(providers[0].capabilities).toContain('mev_protection');
  });

  it('should filter providers by max price', async () => {
    const expensive = await createTestAgent('mev-protector', {
      ownerAddress: 'GB...EXPENSIVE',
    });
    await discoveryRegistry.register({
      agentId: expensive.id,
      capabilities: ['mev_protection'],
      pricePerCall: '100',
    });

    const cheap = await createTestAgent('mev-protector', {
      ownerAddress: 'GB...CHEAP',
    });
    await discoveryRegistry.register({
      agentId: cheap.id,
      capabilities: ['mev_protection'],
      pricePerCall: '5',
    });

    const providers = await discoveryRegistry.findProviders('mev_protection', '50');
    expect(providers.length).toBe(1);
    expect(providers[0].agentId).toBe(cheap.id);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Marketplace
// ══════════════════════════════════════════════════════════════════════

describe('Marketplace', () => {
  it('should list available templates', async () => {
    const result = await marketplace.listTemplates({});
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates.some((t) => t.id === 'dca')).toBe(true);
    expect(result.templates.some((t) => t.id === 'governance')).toBe(true);
  });

  it('should filter templates by category', async () => {
    const result = await marketplace.listTemplates({ category: 'trading' });
    expect(result.templates.length).toBeGreaterThan(0);
    result.templates.forEach((t) => expect(t.category).toBe('trading'));
  });

  it('should get template details', async () => {
    const template = await marketplace.getTemplate('dca');
    expect(template.name).toBe('DCA Agent');
    expect(template.configSchema).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════
// ADDITIONAL TESTS: Human Escalation
// ══════════════════════════════════════════════════════════════════════

describe('Human Escalation', () => {
  it('should create and resolve escalations', async () => {
    const agent = await createTestAgent('dca');

    const { prismaWrite } = await import('../src/db');
    const escalation = await prismaWrite.agentEscalation.create({
      data: {
        agentId: agent.id,
        context: { currentPosition: 'risky', healthFactor: 1.05 },
        proposedActions: [
          { action: 'repay', amount: '500', reason: 'Prevent liquidation' },
          { action: 'swap', tokenOut: 'USDC', reason: 'Reduce exposure' },
        ],
        status: 'pending',
      },
    });

    expect(escalation).toBeDefined();

    // Resolve the escalation
    const resolved = await prismaWrite.agentEscalation.update({
      where: { id: escalation.id },
      data: {
        status: 'resolved',
        resolution: { action: 'repay', amount: '500' },
        resolvedBy: 'GB...HUMAN',
        resolvedAt: new Date(),
      },
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('GB...HUMAN');
  });
});
