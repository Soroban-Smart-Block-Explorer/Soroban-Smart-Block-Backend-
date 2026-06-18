import { describe, it, expect } from 'vitest';
import { decodeMastercardFlags } from '../src/indexer/identity-verifier';
import { ParsedArg } from '../src/indexer/xdr-parser';

describe('Identity Verifier', () => {
  it('should parse verification flags correctly', () => {
    const args: ParsedArg[] = [
        { index: 0, type: 'u32', value: 1 } // Verified
    ];
    const result = decodeMastercardFlags(args);
    expect(result).not.toBeNull();
    expect(result?.isVerified).toBe(true);
    expect(result?.complianceMessage).toContain('verified');
  });

  it('should return unverified if flag is 0', () => {
    const args: ParsedArg[] = [
        { index: 0, type: 'u32', value: 0 } // Not verified
    ];
    const result = decodeMastercardFlags(args);
    expect(result).not.toBeNull();
    expect(result?.isVerified).toBe(false);
    expect(result?.complianceMessage).toContain('failed');
  });
});
