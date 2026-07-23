/**
 * tests/regions/crdt-registry.test.ts
 * Issue #556 — the model-to-CRDT classifier covers every model in
 * schema.prisma (226 at time of writing, satisfying "design CRDTs for all
 * 120+ models") and gives the issue-named models their explicit strategy.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAllModels,
  classifyModel,
  parsePrismaModels,
} from '../../src/regions/crdt-registry';

describe('parsePrismaModels', () => {
  it('parses every model block out of schema.prisma', () => {
    const models = parsePrismaModels();
    expect(models.length).toBeGreaterThan(200);
    expect(models.find((m) => m.name === 'TokenPrice')).toBeDefined();
    expect(models.find((m) => m.name === 'FeedMessage')).toBeDefined();
  });
});

describe('classifyAllModels', () => {
  const classifications = classifyAllModels();
  const byName = new Map(classifications.map((c) => [c.model, c]));

  it('classifies every parsed model with no gaps', () => {
    const parsed = parsePrismaModels();
    expect(classifications).toHaveLength(parsed.length);
    for (const c of classifications) {
      expect(c.strategy).toBeTruthy();
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it('gives the issue-named models their explicit strategy', () => {
    expect(byName.get('TokenPrice')?.strategy).toBe('lww-register');
    expect(byName.get('FeedMessage')?.strategy).toBe('g-set');
    expect(byName.get('Transaction')?.strategy).toBe('add-once-record');
    expect(byName.get('ComplianceReport')?.strategy).toBe('or-set');
    expect(byName.get('ReputationProfile')?.strategy).toBe('g-counter');
  });

  it('classifyModel defaults to lww-register for an unrecognized shape', () => {
    const result = classifyModel({
      name: 'SomeArbitraryModel',
      fields: ['id', 'value'],
      hasUpdatedAt: true,
      hasStatusField: false,
    });
    expect(result.strategy).toBe('lww-register');
  });

  it('classifyModel treats *Event/*Log/*History naming as append-only', () => {
    const result = classifyModel({
      name: 'AuditLog',
      fields: ['id'],
      hasUpdatedAt: false,
      hasStatusField: false,
    });
    expect(result.strategy).toBe('g-set');
  });
});
