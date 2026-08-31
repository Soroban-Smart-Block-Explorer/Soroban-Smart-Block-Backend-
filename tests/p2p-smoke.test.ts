import { describe, it, expect, vi } from 'vitest';
import { loadEsmNodeFactory } from '../src/p2p';
import * as fs from 'fs';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

describe('P2P ESM Node Factory fail-fast check', () => {
  it('throws clear error when dist-esm artifact is missing', async () => {
    await expect(loadEsmNodeFactory()).rejects.toThrow(
      /Missing P2P ESM node factory artifact at .*dist-esm.*node-factory\.mjs/,
    );
  });
});
