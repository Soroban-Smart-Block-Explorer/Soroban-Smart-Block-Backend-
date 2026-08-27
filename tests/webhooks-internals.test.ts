import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret, maskSecret } from '../src/webhooks/secretCrypto';
import {
  redactSensitiveData,
  containsSensitiveData,
  processResponseBody,
} from '../src/webhooks/redaction';
import { backoffMs } from '../src/webhooks/dispatcher';

describe('secretCrypto', () => {
  beforeEach(() => {
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  it('encrypts and decrypts secrets correctly', () => {
    const plaintext = 'my-secret-webhook-key-12345';
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain('v1:');

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for the same secret', () => {
    const plaintext = 'test-secret';
    const encrypted1 = encryptSecret(plaintext);
    const encrypted2 = encryptSecret(plaintext);

    expect(encrypted1).not.toBe(encrypted2);
    expect(decryptSecret(encrypted1)).toBe(plaintext);
    expect(decryptSecret(encrypted2)).toBe(plaintext);
  });

  it('handles legacy plaintext secrets without encryption format', () => {
    const legacySecret = 'a'.repeat(64);
    const decrypted = decryptSecret(legacySecret);
    expect(decrypted).toBe(legacySecret);
  });

  it('masks secrets revealing only last 4 characters', () => {
    const plaintext = 'my-secret-webhook-key';
    const masked = maskSecret(plaintext);

    expect(masked).toContain('key');
    expect(masked.split('*').length - 1).toBeGreaterThan(0);
    expect(masked).toMatch(/^\*+key$/);
  });

  it('handles short secrets in masking', () => {
    const plaintext = 'abc';
    const masked = maskSecret(plaintext);
    expect(masked).toBe('***c');

    const single = maskSecret('x');
    expect(single).toBe('x');
  });

  it('uses custom encryption key when provided', () => {
    const customKey = Buffer.alloc(32, 0xaa).toString('hex');
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = customKey;

    const plaintext = 'secret-with-custom-key';
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);

    expect(decrypted).toBe(plaintext);
  });
});

describe('redaction', () => {
  it('redacts API keys from response bodies', () => {
    const original = 'api_key: "sk-1234567890abcdef"';
    const redacted = redactSensitiveData(original);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('sk-1234567890abcdef');
  });

  it('redacts AWS credentials', () => {
    const original =
      'AKIA3TMEXAMPLE aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const redacted = redactSensitiveData(original);

    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts database connection strings', () => {
    const original = 'mongodb://user:password@localhost:27017/db';
    const redacted = redactSensitiveData(original);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('password');
  });

  it('redacts JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const original = `Authorization: Bearer ${jwt}`;
    const redacted = redactSensitiveData(original);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('eyJ');
  });

  it('redacts email addresses', () => {
    const original = 'Contact us at admin@example.com or support@test.org';
    const redacted = redactSensitiveData(original);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('admin@example.com');
  });

  it('detects sensitive data in response bodies', () => {
    const withApi = 'api_key: "secret123"';
    const withPassword = 'password: "mypass"';
    const clean = 'Hello, world! Status: 200 OK';

    expect(containsSensitiveData(withApi)).toBe(true);
    expect(containsSensitiveData(withPassword)).toBe(true);
    expect(containsSensitiveData(clean)).toBe(false);
  });

  it('returns false for null/undefined/empty responses', () => {
    expect(containsSensitiveData(null)).toBe(false);
    expect(containsSensitiveData(undefined)).toBe(false);
    expect(containsSensitiveData('')).toBe(false);
  });

  it('processes response bodies with truncation and redaction', () => {
    const original =
      'This is a very long response body with api_key: "secret123" in it that should be truncated';
    const processed = processResponseBody(original, 50, true);

    expect(processed!.length).toBeLessThanOrEqual(50);
    expect(processed).toContain('[REDACTED]');
  });

  it('processes response bodies without redaction when disabled', () => {
    const original = 'api_key: "secret123" but no redaction';
    const processed = processResponseBody(original, 100, false);

    expect(processed).toContain('api_key');
    expect(processed).not.toContain('[REDACTED]');
  });

  it('handles non-string response bodies gracefully', () => {
    expect(processResponseBody(null)).toBeNull();
    expect(processResponseBody(undefined)).toBeUndefined();
  });
});

describe('dispatcher backoff', () => {
  it('calculates exponential backoff correctly', () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(3)).toBe(90_000);
    expect(backoffMs(4)).toBe(270_000);
    expect(backoffMs(5)).toBe(810_000);
  });

  it('caps backoff at 15 minutes', () => {
    expect(backoffMs(6)).toBe(900_000);
    expect(backoffMs(10)).toBe(900_000);
    expect(backoffMs(100)).toBe(900_000);
  });

  it('increases exponentially until cap', () => {
    const delays = [1, 2, 3, 4, 5].map((i) => backoffMs(i));
    for (let i = 0; i < delays.length - 1; i++) {
      expect(delays[i + 1]).toBeGreaterThan(delays[i]);
    }
  });
});
