import { describe, it, expect } from 'vitest';
import {
  classifyContract,
  detectAnomalousPatterns,
  detectAdminFunctions,
} from '../src/intelligence/heuristic-classifier';

describe('classifyContract', () => {
  it('classifies SEP-41 token contracts', () => {
    const fns = ['transfer', 'balance', 'approve', 'allowance', 'mint', 'burn', 'decimals', 'symbol', 'name', 'total_supply'];
    const result = classifyContract(fns);
    expect(result.category).toBe('token');
    expect(result.confidence).toBe('high');
    expect(result.protocols).toContain('SEP-41');
  });

  it('classifies DEX / AMM contracts', () => {
    const fns = ['swap', 'get_price', 'add_liquidity', 'remove_liquidity', 'get_reserves', 'quote'];
    const result = classifyContract(fns);
    expect(['dex', 'liquidity']).toContain(result.category);
    expect(result.protocols).toContain('DEX');
  });

  it('classifies lending protocol contracts', () => {
    const fns = ['borrow', 'repay', 'deposit', 'withdraw', 'liquidate', 'collateral', 'supply'];
    const result = classifyContract(fns);
    expect(result.category).toBe('lending');
    expect(result.protocols).toContain('Lending');
  });

  it('classifies NFT contracts', () => {
    const fns = ['mint', 'transfer', 'owner_of', 'token_uri', 'approve', 'set_approval'];
    const result = classifyContract(fns);
    expect(result.category).toBe('nft');
    expect(result.protocols).toContain('NFT');
  });

  it('classifies staking contracts', () => {
    const fns = ['stake', 'unstake', 'claim', 'reward_rate', 'epoch', 'bonding'];
    const result = classifyContract(fns);
    expect(result.category).toBe('staking');
    expect(result.protocols).toContain('Staking');
  });

  it('classifies governance contracts', () => {
    const fns = ['propose', 'vote', 'execute', 'cancel', 'delegate', 'quorum'];
    const result = classifyContract(fns);
    expect(result.category).toBe('governance');
    expect(result.protocols).toContain('Governance');
  });

  it('classifies oracle contracts', () => {
    const fns = ['get_price', 'set_price', 'update_price', 'price_feed', 'aggregator', 'report'];
    const result = classifyContract(fns);
    expect(result.category).toBe('oracle');
    expect(result.protocols).toContain('Oracle');
  });

  it('classifies vesting contracts', () => {
    const fns = ['vest', 'claim', 'release', 'schedule', 'cliff', 'beneficiary', 'linear'];
    const result = classifyContract(fns);
    expect(result.category).toBe('vesting');
  });

  it('classifies multisig contracts', () => {
    const fns = ['submit', 'confirm', 'revoke', 'execute', 'owners', 'required', 'add_owner', 'remove_owner', 'threshold'];
    const result = classifyContract(fns);
    expect(result.category).toBe('multisig');
  });

  it('classifies registry contracts', () => {
    const fns = ['register', 'resolve', 'lookup', 'set', 'get', 'list', 'remove', 'update', 'record'];
    const result = classifyContract(fns);
    expect(result.category).toBe('registry');
  });

  it('returns unknown for generic/empty contracts', () => {
    const result = classifyContract([]);
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('returns unknown for unrecognised function names', () => {
    const result = classifyContract(['foo', 'bar', 'baz']);
    expect(result.category).toBe('unknown');
  });

  it('includes matchedPatterns in result', () => {
    const fns = ['transfer', 'balance', 'approve', 'allowance', 'decimals'];
    const result = classifyContract(fns);
    expect(result.matchedPatterns.length).toBeGreaterThan(0);
    expect(result.matchedPatterns).toContain('transfer');
  });

  it('assigns high confidence when many patterns match', () => {
    const fns = ['transfer', 'balance', 'approve', 'allowance', 'mint', 'burn', 'decimals', 'symbol', 'name', 'total_supply'];
    const result = classifyContract(fns);
    expect(result.confidence).toBe('high');
  });

  it('returns a non-empty description', () => {
    const fns = ['transfer', 'balance', 'approve', 'allowance', 'mint'];
    const result = classifyContract(fns);
    expect(result.description.length).toBeGreaterThan(10);
  });
});

describe('detectAnomalousPatterns', () => {
  it('flags suspicious function names', () => {
    const flags = detectAnomalousPatterns(['transfer', 'drain', 'balance']);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]).toContain('drain');
  });

  it('returns empty array for normal functions', () => {
    const flags = detectAnomalousPatterns(['transfer', 'balance', 'approve']);
    expect(flags).toHaveLength(0);
  });
});

describe('detectAdminFunctions', () => {
  it('identifies admin/privileged functions', () => {
    const fns = ['transfer', 'admin', 'set_admin', 'upgrade', 'pause'];
    const admin = detectAdminFunctions(fns);
    expect(admin).toContain('admin');
    expect(admin).toContain('upgrade');
    expect(admin).not.toContain('transfer');
  });

  it('returns empty array when no admin functions present', () => {
    const admin = detectAdminFunctions(['transfer', 'balance', 'swap']);
    expect(admin).toHaveLength(0);
  });
});
