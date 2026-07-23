import { describe, expect, it } from 'vitest';
import {
  classifyOracleContract,
  detectOracleManipulation,
  scoreOracleReliability,
} from '../src/services/oracleIntelligence';

describe('oracle intelligence', () => {
  it('classifies known oracle contracts and scores reliability', () => {
    const detection = classifyOracleContract({
      address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      name: 'price_feed',
      functionSignatures: [{ name: 'set_price' }],
    });

    expect(detection.kind).toBe('builtin');
    expect(detection.evidence.length).toBeGreaterThan(0);

    const score = scoreOracleReliability(
      [
        { price: 100, timestamp: Date.now() - 1000, deviationPct: 0.1 },
        { price: 100.2, timestamp: Date.now() - 2000, deviationPct: 0.2 },
        { price: 100.3, timestamp: Date.now() - 3000, deviationPct: 0.3 },
      ],
      {
        updateFrequencyMs: 5000,
        uptimePct: 99.5,
        latencyMs: 85,
        decentralizationScore: 0.9,
        historicalAccuracyPct: 98.5,
      },
    );

    expect(score.grade).toMatch(/A|B|C|D|F/);
    expect(score.compositeScore).toBeGreaterThan(0);
  });

  it('flags suspicious manipulation patterns', () => {
    const findings = detectOracleManipulation([
      { price: 100, timestamp: Date.now() - 60000 },
      { price: 1000, timestamp: Date.now() - 30000 },
      { price: 100.5, timestamp: Date.now() - 10000 },
    ]);

    expect(findings.length).toBeGreaterThan(0);
  });
});
