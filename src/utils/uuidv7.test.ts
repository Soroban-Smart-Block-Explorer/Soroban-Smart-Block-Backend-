import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('generates a well-formed UUIDv7 string', () => {
    expect(uuidv7()).toMatch(UUID_V7_PATTERN);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });

  it('sorts lexicographically in generation order', async () => {
    const first = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = uuidv7();

    expect(first < second).toBe(true);
  });

  it('encodes the current time in the leading 48 bits', () => {
    const before = BigInt(Date.now());
    const id = uuidv7();
    const after = BigInt(Date.now());

    const timestampHex = id.split('-').slice(0, 2).join('');
    const timestamp = BigInt(`0x${timestampHex}`);

    expect(timestamp >= before).toBe(true);
    expect(timestamp <= after).toBe(true);
  });
});
