/**
 * At-rest encryption for developer webhook signing secrets (DevWebhook.secret).
 *
 * The raw secret must remain recoverable: it's used as the HMAC-SHA256 key
 * when the server signs outbound webhook deliveries (see
 * src/api/developer/webhooks.ts), so it can't be one-way hashed the way a
 * password or API key is — the server needs the plaintext back at delivery
 * time. Instead it's encrypted at rest with AES-256-GCM under a server-held
 * key (WEBHOOK_SECRET_ENCRYPTION_KEY), so a database breach alone does not
 * expose usable secrets.
 *
 * Stored format: "v1:<iv>:<authTag>:<ciphertext>" (all hex). Values written
 * before this change are 64-char hex strings with no ':' separators — those
 * are detected and passed through unchanged by decryptSecret() so existing
 * webhooks keep working without a data migration.
 */

import crypto from 'crypto';
import { logger } from '../logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const FORMAT_PREFIX = 'v1';

// Fallback for local/dev environments only. Production deployments must set
// WEBHOOK_SECRET_ENCRYPTION_KEY (32-byte key, hex-encoded) or webhook secrets
// are encrypted under a value that ships in source control.
const DEV_FALLBACK_KEY = 'soroban-explorer-webhook-secret-v1';

let warnedMissingKey = false;

function getEncryptionKey(): Buffer {
  const raw = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!raw && !warnedMissingKey) {
    warnedMissingKey = true;
    logger.warn(
      'WEBHOOK_SECRET_ENCRYPTION_KEY is not set; falling back to an insecure default. Set this in production.',
    );
  }
  const material = raw ?? DEV_FALLBACK_KEY;
  const key = /^[0-9a-fA-F]{64}$/.test(material)
    ? Buffer.from(material, 'hex')
    : crypto.createHash('sha256').update(material).digest();
  return key;
}

/** Encrypt a plaintext webhook secret for storage. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_PREFIX,
    iv.toString('hex'),
    authTag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

/**
 * Decrypt a stored webhook secret. Values that don't match the encrypted
 * format (legacy plaintext secrets written before this change) are returned
 * as-is.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) {
    return stored; // legacy plaintext secret
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Mask a secret for API responses, revealing only the last 4 characters. */
export function maskSecret(plaintext: string): string {
  const last4 = plaintext.slice(-4);
  return `${'*'.repeat(Math.max(plaintext.length - 4, 0))}${last4}`;
}
