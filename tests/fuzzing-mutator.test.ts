import { describe, it, expect } from 'vitest';
import { generateMutations } from '../src/fuzzing/mutator';
import { getBoundaryValues } from '../src/fuzzing/corpus';

describe('generateMutations', () => {
  it('returns mutations for numeric args', () => {
    const mutations = generateMutations([42]);
    expect(mutations.length).toBeGreaterThan(0);
    const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
    expect(strategies).toContain('bit_flip');
    expect(strategies).toContain('boundary_value');
  });

  it('returns mutations for string args', () => {
    const mutations = generateMutations(['hello']);
    expect(mutations.length).toBeGreaterThan(0);
    const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
    expect(strategies).toContain('string_injection');
  });

  it('returns mutations for address-like strings', () => {
    const addr = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    const mutations = generateMutations([addr]);
    const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
    expect(strategies).toContain('address_substitution');
  });

  it('returns mutations for boolean args', () => {
    const mutations = generateMutations([true]);
    const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
    expect(strategies).toContain('bit_flip');
  });

  it('returns mutations for null args', () => {
    const mutations = generateMutations([null]);
    expect(mutations.length).toBeGreaterThan(0);
  });

  it('includes reentrancy_craft for multi-arg calls', () => {
    const mutations = generateMutations([42, 'user', true]);
    const strategies = mutations.flatMap((m) => m.mutations.map((mt) => mt.strategy));
    expect(strategies).toContain('reentrancy_craft');
  });

  it('sorts by priority descending (boundary/large before flip)', () => {
    const mutations = generateMutations([100]);
    const firstPriority = Math.max(...mutations[0].mutations.map((m) => m.priority));
    const lastPriority = Math.max(...mutations[mutations.length - 1].mutations.map((m) => m.priority));
    expect(firstPriority).toBeGreaterThanOrEqual(lastPriority);
  });

  it('produces unique mutated arg sets', () => {
    const mutations = generateMutations([0, 0]);
    const serialised = mutations.map((m) => JSON.stringify(m.args));
    const unique = new Set(serialised);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('caps at 200 mutations per call', () => {
    const largeArgs = Array.from({ length: 20 }, (_, i) => i);
    const mutations = generateMutations(largeArgs);
    expect(mutations.length).toBeLessThanOrEqual(200);
  });

  it('preserves non-mutated args', () => {
    const mutations = generateMutations([1, 2, 3]);
    for (const m of mutations) {
      expect(m.args.length).toBe(3);
    }
  });
});

describe('getBoundaryValues', () => {
  it('returns boundary values for u32', () => {
    const vals = getBoundaryValues('u32');
    expect(vals).toContain(0);
    expect(vals).toContain(0xffffffff);
  });

  it('returns boundary values for i128', () => {
    const vals = getBoundaryValues('i128');
    expect(vals.some((v) => String(v).startsWith('-'))).toBe(true);
  });

  it('returns boundary values for string', () => {
    const vals = getBoundaryValues('string');
    expect(vals).toContain('');
  });

  it('returns boundary values for bool', () => {
    const vals = getBoundaryValues('bool');
    expect(vals).toContain(true);
    expect(vals).toContain(false);
  });

  it('returns defaults for unknown type', () => {
    const vals = getBoundaryValues('unknown_type');
    expect(vals.length).toBeGreaterThan(0);
  });
});
