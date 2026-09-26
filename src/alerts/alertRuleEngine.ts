import { randomUUID } from 'crypto';
import { z } from 'zod';
import { logger } from '../logger';
import { safePost } from '../webhooks/ssrf-guard';
import { realtimeHub, RealtimeMessage, ContractEventPayload } from '../realtime/eventHub';
import { getPreferences, pushNotification } from '../notifications/notificationCenter';

const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
const FIELDS = [
  'contractId',
  'eventType',
  'data',
  'topics',
  'ledgerSequence',
  'transactionHash',
] as const;

export const conditionSchema = z.object({
  field: z.enum(FIELDS),
  op: z.enum(OPERATORS),
  value: z.union([z.string().max(512), z.number()]),
});

export const alertRuleSchema = z.object({
  name: z.string().min(1).max(120),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).min(1).max(10),
  channels: z
    .array(z.enum(['inbox', 'webhook', 'sse']))
    .min(1)
    .default(['inbox']),
  webhookUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
});

export type AlertCondition = z.infer<typeof conditionSchema>;
export type AlertRuleInput = z.infer<typeof alertRuleSchema>;
export interface AlertRule extends AlertRuleInput {
  id: string;
  userId: string;
  createdAt: string;
  lastTriggeredAt?: string;
}

const MAX_RULES_PER_USER = 50;
const rules = new Map<string, AlertRule>();

function compare(actual: unknown, { op, value }: AlertCondition): boolean {
  if (op === 'contains') {
    const haystack = Array.isArray(actual) ? actual.join(' ') : String(actual ?? '');
    return haystack.includes(String(value));
  }
  if (op === 'eq') return String(actual) === String(value);
  if (op === 'neq') return String(actual) !== String(value);
  const a = Number(actual);
  const b = Number(value);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

export function evaluateRule(
  rule: Pick<AlertRule, 'match' | 'conditions'>,
  event: ContractEventPayload,
): boolean {
  const results = rule.conditions.map((c) => compare(event[c.field], c));
  return rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function createRule(userId: string, input: AlertRuleInput): AlertRule {
  if (listRules(userId).length >= MAX_RULES_PER_USER) {
    throw new Error(`Rule limit reached (${MAX_RULES_PER_USER})`);
  }
  if (input.channels.includes('webhook') && !input.webhookUrl) {
    throw new Error('webhookUrl is required for the webhook channel');
  }
  const rule: AlertRule = {
    ...input,
    id: randomUUID(),
    userId,
    createdAt: new Date().toISOString(),
  };
  rules.set(rule.id, rule);
  return rule;
}

export function listRules(userId: string): AlertRule[] {
  return [...rules.values()].filter((r) => r.userId === userId);
}

export function getRule(userId: string, id: string): AlertRule | undefined {
  const rule = rules.get(id);
  return rule?.userId === userId ? rule : undefined;
}

export function updateRule(
  userId: string,
  id: string,
  input: Partial<AlertRuleInput>,
): AlertRule | undefined {
  const rule = getRule(userId, id);
  if (!rule) return undefined;
  Object.assign(rule, input);
  return rule;
}

export function deleteRule(userId: string, id: string): boolean {
  return getRule(userId, id) ? rules.delete(id) : false;
}

async function deliver(rule: AlertRule, event: ContractEventPayload): Promise<void> {
  const prefs = getPreferences(rule.userId);
  const title = `Alert: ${rule.name}`;
  const body = `${event.eventType} on ${event.contractId} at ledger ${event.ledgerSequence}`;

  if (rule.channels.includes('inbox')) {
    pushNotification({
      userId: rule.userId,
      category: 'alert',
      title,
      body,
      data: { ruleId: rule.id, event },
    });
  }
  if (rule.channels.includes('webhook') && rule.webhookUrl && prefs.channels.webhook) {
    await safePost(
      rule.webhookUrl,
      JSON.stringify({ ruleId: rule.id, name: rule.name, event }),
      { 'Content-Type': 'application/json' },
      5000,
    ).catch((err) =>
      logger.warn('Alert rule webhook delivery failed', { error: String(err), ruleId: rule.id }),
    );
  }
}

/** Evaluates every enabled rule against a contract event and delivers matches. */
export async function processEvent(event: ContractEventPayload): Promise<number> {
  let matched = 0;
  for (const rule of rules.values()) {
    if (!rule.enabled || !evaluateRule(rule, event)) continue;
    matched++;
    rule.lastTriggeredAt = new Date().toISOString();
    await deliver(rule, event);
  }
  return matched;
}

let unsubscribe: (() => void) | null = null;

/** Wires the engine to the realtime hub so indexed events are evaluated live. */
export function startAlertRuleEngine(): void {
  if (unsubscribe) return;
  unsubscribe = realtimeHub.subscribe((m: RealtimeMessage) => {
    if (m.topic !== 'contract_event') return;
    processEvent(m.payload as ContractEventPayload).catch((err) =>
      logger.error('Alert rule evaluation failed', { error: String(err) }),
    );
  });
}

/** Test helper: clears rules and detaches from the hub. */
export function resetAlertRuleEngine(): void {
  rules.clear();
  unsubscribe?.();
  unsubscribe = null;
}
