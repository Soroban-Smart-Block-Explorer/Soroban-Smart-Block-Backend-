import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn() },
  },
}));
vi.mock('../../src/indexer/args-decoder', () => ({
  decodeTypedArgs: vi.fn().mockReturnValue({ amount: { formatted: '100' } }),
}));
vi.mock('../../src/indexer/template-engine', () => ({
  renderTemplate: vi.fn().mockReturnValue('rendered output'),
}));
vi.mock('../../src/indexer/sep41-parser', () => ({
  getSep41Abi: vi.fn().mockReturnValue({
    functions: [
      {
        name: 'transfer',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'i128' },
        ],
        humanTemplate: '{from} sent {amount} to {to}',
      },
    ],
  }),
}));

import { getContractAbi, decodeArgs, renderHuman, SEP41_ABI } from '../../src/indexer/registry';
import * as db from '../../src/db';

const { contract } = db.prismaRead;

describe('SEP41_ABI', () => {
  it('is defined and has functions', () => {
    expect(SEP41_ABI).toBeDefined();
    expect(SEP41_ABI.functions.length).toBeGreaterThan(0);
  });
});

describe('getContractAbi', () => {
  it('returns null when contract is not found', async () => {
    vi.mocked(contract.findUnique).mockResolvedValue(null);
    const result = await getContractAbi('CA_UNKNOWN');
    expect(result).toBeNull();
  });

  it('returns SEP41_ABI for token contracts', async () => {
    vi.mocked(contract.findUnique).mockResolvedValue({ isToken: true, abi: null } as any);
    const result = await getContractAbi('CA_TOKEN');
    expect(result).toBe(SEP41_ABI);
  });

  it('returns stored ABI for non-token contracts', async () => {
    const customAbi = { functions: [] };
    vi.mocked(contract.findUnique).mockResolvedValue({
      isToken: false,
      abi: customAbi,
    } as any);
    const result = await getContractAbi('CA_CUSTOM');
    expect(result).toEqual(customAbi);
  });

  it('returns null for non-token contracts without ABI', async () => {
    vi.mocked(contract.findUnique).mockResolvedValue({ isToken: false, abi: null } as any);
    const result = await getContractAbi('CA_NO_ABI');
    expect(result).toBeNull();
  });
});

describe('decodeArgs', () => {
  it('returns null when function not in ABI', () => {
    const result = decodeArgs('unknown_fn', [], SEP41_ABI);
    expect(result).toBeNull();
  });

  it('returns decoded args map for known function', () => {
    const result = decodeArgs('transfer', [], SEP41_ABI);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('amount');
  });
});

describe('renderHuman', () => {
  it('returns fallback string when function has no humanTemplate', () => {
    const abi = { functions: [{ name: 'transfer', inputs: [] }] };
    const result = renderHuman('transfer', {}, abi, 'MyContract');
    expect(result).toContain('transfer');
    expect(result).toContain('MyContract');
  });

  it('delegates to renderTemplate when humanTemplate exists', () => {
    const result = renderHuman('transfer', { from: 'GA...' }, SEP41_ABI, 'MyToken');
    expect(result).toBe('rendered output');
  });

  it('uses "contract" when contractName is null', () => {
    const abi = { functions: [{ name: 'transfer', inputs: [] }] };
    const result = renderHuman('transfer', {}, abi, null);
    expect(result).toContain('contract');
  });
});
