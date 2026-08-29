/**
 * Webhook signature verification utilities (issue #884)
 *
 * Provides:
 *  1. Constant-time HMAC-SHA256 signature verification via crypto.timingSafeEqual.
 *  2. Timestamp-skew window — rejects payloads whose X-Webhook-Timestamp is
 *     outside TIMESTAMP_TOLERANCE_MS of the server clock to limit replay windows.
 *  3. In-process replay cache — remembers the nonce (timestamp+signature) of
 *     every accepted request for the duration of the skew window so that an
 *     attacker who captures a valid request cannot replay it even within the
 *     skew window.
 *
 * Signature format (outbound, signed by dispatcher):
 *   X-Webhook-Signature: sha256=<hex-digest>
 *   X-Webhook-Timestamp: <unix-epoch-ms>   (optional — skew check only applies
 *                                            when this header is present)
 *
 * Usage (inbound webhook handler):
 *   import { verifyWebhookSignature } from '../webhooks/webhookVerify';
 *   const result = verifyWebhookSignature(rawBody, secret, headers);
 *   if (!result.ok) return res.status(401).json({ error: result.reason });
 */

import crypto from 'crypto';

// ── Configuration ─────────────────────────────────────────────────────────────

/** How far (ms) the sender's timestamp may drift from our clock. */
export const TIMESTAMP_TOLERANCE_MS =
  Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_MS ?? '') || 5 * 60 * 1000; // 5 minutes

/** Replay cache TTL — must cover the full tolerance window (plus some slack). */
const REPLAY_CACHE_TTL_MS = TIMESTAMP_TOLERANCE_MS * 2 + 10_000;

/** Maximum number of nonces to keep in the replay cache. */
const REPLAY_CACHE_MAX = 100_000;

// ── Replay cache ──────────────────────────────────────────────────────────────

/** Map<nonce, expiresAt>. Nonce = `${timestampMs}:${signatureHex}` */
const replayCache = new Map<string, number>();

/** Periodically evict expired nonces to keep memory bounded. */
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of replayCache.entries()) {
    if (expiresAt < now) replayCache.delete(nonce);
  }
}, 60_000);

function isReplay(nonce: string): boolean {
  return replayCache.has(nonce);
}

function recordNonce(nonce: string): void {
  if (replayCache.size >= REPLAY_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = replayCache.keys().next().value;
    if (firstKey !== undefined) replayCache.delete(firstKey);
  }
  replayCache.set(nonce, Date.now() + REPLAY_CACHE_TTL_MS);
}

// ── Core verification logic ───────────────────────────────────────────────────

export interface VerifyResult {
  ok: true;
  signatureHex: string;
}

export interface VerifyFailure {
  ok: false;
  reason: string;
}

/**
 * Verify an inbound webhook signature.
 *
 * @param rawBody        - The raw request body (Buffer or string).
 * @param secret         - The shared signing secret (plaintext).
 * @param signatureHeader - Value of X-Webhook-Signature (e.g. "sha256=abc123").
 * @param timestampHeader - Value of X-Webhook-Timestamp (unix epoch ms, as string).
 *                          Pass undefined to skip skew check (not recommended for production).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader?: string | undefined,
): VerifyResult | VerifyFailure {
  // ── 1. Timestamp skew check ──────────────────────────────────────────────
  let timestampMs: number | undefined;

  if (timestampHeader !== undefined) {
    timestampMs = Number(timestampHeader);

    if (!Number.isFinite(timestampMs)) {
      return { ok: false, reason: 'X-Webhook-Timestamp is not a valid number' };
    }

    const skew = Math.abs(Date.now() - timestampMs);
    if (skew > TIMESTAMP_TOLERANCE_MS) {
      return {
        ok: false,
        reason: `Request timestamp is outside the ${TIMESTAMP_TOLERANCE_MS}ms tolerance window (skew: ${skew}ms)`,
      };
    }
  }

  // ── 2. Signature format check ────────────────────────────────────────────
  if (!signatureHeader) {
    return { ok: false, reason: 'Missing X-Webhook-Signature header' };
  }

  // Accept "sha256=<hex>" format (64 hex chars) or bare hex (legacy).
  const hexMatch = signatureHeader.match(/^(?:sha256=)?([0-9a-f]{64})$/i);
  if (!hexMatch) {
    return { ok: false, reason: 'Malformed X-Webhook-Signature header (expected sha256=<hex64>)' };
  }

  const receivedHex = hexMatch[1].toLowerCase();

  // ── 3. HMAC computation ──────────────────────────────────────────────────
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody as string, 'utf8');
  const expectedBuf = crypto.createHmac('sha256', secret).update(bodyBuf).digest();
  const receivedBuf = Buffer.from(receivedHex, 'hex');

  // Constant-time comparison — both buffers are always 32 bytes.
  const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);

  if (!isValid) {
    return { ok: false, reason: 'Signature mismatch' };
  }

  // ── 4. Replay check ──────────────────────────────────────────────────────
  // Only perform replay detection when a timestamp is provided (nonce = ts+sig).
  if (timestampMs !== undefined) {
    const nonce = `${timestampMs}:${receivedHex}`;
    if (isReplay(nonce)) {
      return { ok: false, reason: 'Replayed request (nonce already seen)' };
    }
    recordNonce(nonce);
  }

  return { ok: true, signatureHex: receivedHex };
}

/**
 * Compute the outbound webhook signature for a given body and secret.
 * Returns the value to put in X-Webhook-Signature.
 */
export function signWebhookBody(body: Buffer | string, secret: string): string {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'utf8');
  const hex = crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
  return `sha256=${hex}`;
}
