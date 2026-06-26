import { recordAudit } from './audit';

interface BlockingRule {
  id: string;
  name: string;
  description?: string;
  matchThreshold: number;
  sources: string[];
  action: 'block' | 'flag' | 'escalate';
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface BlockingAction {
  id: string;
  ruleId: string;
  ruleName: string;
  address: string;
  txHash?: string;
  action: string;
  matchScore: number;
  matchType: string;
  blockedAt: string;
  status: 'blocked' | 'bypassed' | 'reviewed';
}

const blockingRules: BlockingRule[] = [];
const blockingActions: BlockingAction[] = [];

export function createBlockingRule(data: {
  name: string;
  description?: string;
  matchThreshold: number;
  sources: string[];
  action: 'block' | 'flag' | 'escalate';
  createdBy?: string;
}): BlockingRule {
  const now = new Date().toISOString();
  const rule: BlockingRule = {
    id: `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: data.name,
    description: data.description,
    matchThreshold: data.matchThreshold,
    sources: data.sources,
    action: data.action,
    enabled: true,
    createdBy: data.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  blockingRules.push(rule);

  recordAudit({
    action: 'create_blocking_rule',
    resourceType: 'blocking_rule',
    resourceId: rule.id,
    details: { name: data.name, threshold: data.matchThreshold, action: data.action },
  });

  return rule;
}

export function updateBlockingRule(id: string, data: Partial<BlockingRule>): BlockingRule | null {
  const index = blockingRules.findIndex((r) => r.id === id);
  if (index === -1) return null;

  blockingRules[index] = {
    ...blockingRules[index],
    ...data,
    updatedAt: new Date().toISOString(),
  };
  return blockingRules[index];
}

export function listBlockingRules(): BlockingRule[] {
  return blockingRules.filter((r) => r.enabled);
}

export function getBlockingRule(id: string): BlockingRule | undefined {
  return blockingRules.find((r) => r.id === id);
}

export function deleteBlockingRule(id: string): boolean {
  const index = blockingRules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  blockingRules[index].enabled = false;
  return true;
}

export function recordBlockingAction(action: {
  ruleId: string;
  address: string;
  txHash?: string;
  matchScore: number;
  matchType: string;
}): BlockingAction {
  const rule = blockingRules.find((r) => r.id === action.ruleId);
  const blockingAction: BlockingAction = {
    id: `ba_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ruleId: action.ruleId,
    ruleName: rule?.name ?? 'unknown',
    address: action.address,
    txHash: action.txHash,
    action: rule?.action ?? 'flag',
    matchScore: action.matchScore,
    matchType: action.matchType,
    blockedAt: new Date().toISOString(),
    status: 'blocked',
  };
  blockingActions.push(blockingAction);
  return blockingAction;
}

export function getBlockingActions(
  limit: number = 50,
  offset: number = 0,
): { actions: BlockingAction[]; total: number } {
  const sorted = [...blockingActions].reverse();
  return {
    actions: sorted.slice(offset, offset + limit),
    total: blockingActions.length,
  };
}

export function evaluateBlocking(
  address: string,
  score: number,
  matchType: string,
): BlockingAction | null {
  for (const rule of blockingRules) {
    if (!rule.enabled) continue;
    if (score >= rule.matchThreshold) {
      return recordBlockingAction({
        ruleId: rule.id,
        address,
        matchScore: score,
        matchType,
      });
    }
  }
  return null;
}
