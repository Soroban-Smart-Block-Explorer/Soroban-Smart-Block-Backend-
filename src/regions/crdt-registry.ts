import fs from 'fs';
import path from 'path';

/**
 * Maps every Prisma model to the CRDT strategy its cross-region replication
 * should use (Issue #556: "Design CRDTs for all 120+ models").
 *
 * Hand-picking a bespoke CRDT for each of the 226 models in schema.prisma
 * isn't something a reviewer could verify field-by-field, and most models
 * don't need a bespoke choice — they fall cleanly into one of five
 * observable shapes. So this registry does two things:
 *
 *  1. Explicit overrides for the models Issue #556 names directly, where
 *     the business meaning (not just the field shape) determines the CRDT.
 *  2. A structural classifier for everything else, driven only by
 *     mechanically observable properties of the Prisma model (field names,
 *     `@updatedAt`, presence of a status/flag-like column). This is the
 *     "category-based" methodology described in
 *     MULTI_REGION_CRDT_DESIGN.md — it is intentionally conservative and
 *     defaults to the safest strategy (`lww-register`) when a model has any
 *     mutable field, since an incorrect grow-only/counter choice would
 *     silently drop legitimate updates.
 */
export type CrdtStrategy =
  | 'lww-register' // whole-row last-writer-wins (default for mutable rows)
  | 'g-counter' // monotonically increasing counter, merge = max-then-sum
  | 'or-set' // flag/membership that can toggle and re-toggle
  | 'g-set' // append-only log/event/message, never updated or deleted
  | 'add-once-record'; // immutable payload + a few independently-LWW mutable fields

export interface ModelClassification {
  model: string;
  strategy: CrdtStrategy;
  reason: string;
}

/** Business-driven overrides for the models Issue #556 names explicitly. */
const OVERRIDES: Record<string, { strategy: CrdtStrategy; reason: string }> = {
  TokenPrice: {
    strategy: 'lww-register',
    reason:
      'Issue #556: price quotes — only the latest observation matters, stale writes are discarded outright.',
  },
  ReputationScore: {
    strategy: 'g-counter',
    reason:
      'Issue #556: increment-only, merge = max per region then summed; matches G-Counter semantics exactly.',
  },
  ReputationProfile: {
    strategy: 'g-counter',
    reason:
      'Closest existing analog to the issue-named ReputationScore model — score field behaves the same way.',
  },
  ComplianceScreeningResult: {
    strategy: 'or-set',
    reason:
      'Issue #556: positive/negative flag that can flip and re-flip; OR-Set allows re-add after removal.',
  },
  ComplianceReport: {
    strategy: 'or-set',
    reason: 'Closest existing analog to the issue-named ComplianceScreeningResult model.',
  },
  RwaComplianceEvent: {
    strategy: 'or-set',
    reason: 'Screening/flag events that can be asserted and later cleared per subject.',
  },
  FeedMessage: {
    strategy: 'g-set',
    reason: 'Issue #556: grow-only, add-only, no deletions.',
  },
  Transaction: {
    strategy: 'add-once-record',
    reason:
      'Issue #556: "essentially add-only, but status updates need LWW" — custom composite CRDT.',
  },
};

const APPEND_ONLY_NAME_PATTERN = /(Event|Log|History|Message|Snapshot|Audit)$/;
const COUNTER_NAME_PATTERN = /(Count|Score|Total|Tally)$/;
const FLAG_NAME_PATTERN = /(Flag|Screening|Dispute|Report|Badge)$/;

export interface ParsedModel {
  name: string;
  fields: string[];
  hasUpdatedAt: boolean;
  hasStatusField: boolean;
}

/** Minimal structural parser for schema.prisma — good enough to drive classification, not a full DSL parser. */
export function parsePrismaModels(schemaPath: string = defaultSchemaPath()): ParsedModel[] {
  const source = fs.readFileSync(schemaPath, 'utf8');
  const modelBlockPattern = /model\s+(\w+)\s*\{([^}]*)\}/g;
  const models: ParsedModel[] = [];
  let match: RegExpExecArray | null;
  while ((match = modelBlockPattern.exec(source)) !== null) {
    const [, name, body] = match;
    const fieldLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('@@'));
    const fields = fieldLines.map((l) => l.split(/\s+/)[0]).filter(Boolean);
    models.push({
      name,
      fields,
      hasUpdatedAt: /@updatedAt/.test(body),
      hasStatusField: fields.some((f) =>
        /^(status|state|flag|isActive|isFrozen|isRevoked)$/i.test(f),
      ),
    });
  }
  return models;
}

function defaultSchemaPath(): string {
  return path.join(__dirname, '..', '..', 'prisma', 'schema.prisma');
}

/**
 * Structural fallback for models Issue #556 doesn't name individually.
 * Order matters: append-only naming wins over counter/flag naming, and any
 * model with a mutable status field defaults to LWW rather than risk
 * silently dropping updates under a grow-only strategy.
 */
export function classifyModel(model: ParsedModel): ModelClassification {
  const override = OVERRIDES[model.name];
  if (override) {
    return { model: model.name, ...override };
  }

  if (APPEND_ONLY_NAME_PATTERN.test(model.name) && !model.hasUpdatedAt) {
    return {
      model: model.name,
      strategy: 'g-set',
      reason:
        'Append-only naming convention and no @updatedAt column observed — treated as an immutable log.',
    };
  }

  if (COUNTER_NAME_PATTERN.test(model.name) && !model.hasStatusField) {
    return {
      model: model.name,
      strategy: 'g-counter',
      reason: 'Counter/score naming convention with no independent status field.',
    };
  }

  if (FLAG_NAME_PATTERN.test(model.name)) {
    return {
      model: model.name,
      strategy: 'or-set',
      reason: 'Flag/screening/dispute naming convention — membership can toggle and re-toggle.',
    };
  }

  return {
    model: model.name,
    strategy: 'lww-register',
    reason: model.hasUpdatedAt
      ? 'Has @updatedAt and no more specific shape matched — safest default for a mutable row is whole-row LWW.'
      : 'No more specific shape matched; defaulting to whole-row LWW rather than assuming append-only.',
  };
}

export function classifyAllModels(schemaPath?: string): ModelClassification[] {
  return parsePrismaModels(schemaPath).map(classifyModel);
}
