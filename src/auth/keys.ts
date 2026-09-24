import * as forge from 'node-forge';
import { cacheGet, cacheSet } from '../cache';
import { config } from '../config';

export interface KeyPair {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: number;
}

const KEYS_CACHE_KEY = 'auth:jwks:keys';
const KEY_TTL = 7 * 24 * 3600; // 7 days cache
let currentKeyPair: KeyPair | null = null;
const graceKeyPairs = new Map<string, KeyPair>();

function generateKid(): string {
  return `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateRsaKeyPair(): KeyPair {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  return {
    kid: generateKid(),
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
    publicKeyPem: forge.pki.publicKeyToPem(keypair.publicKey),
    createdAt: Date.now(),
  };
}

export async function getOrCreateKeyPair(): Promise<KeyPair> {
  if (currentKeyPair) return currentKeyPair;

  const cached = await cacheGet<KeyPair>(KEYS_CACHE_KEY);
  if (cached) {
    currentKeyPair = cached;
    return cached;
  }

  // Check env for pre-generated keys (production / HSM path)
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    currentKeyPair = {
      kid: process.env.JWT_KEY_ID ?? 'env_key',
      privateKeyPem: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      publicKeyPem: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
      createdAt: Date.now(),
    };
    await cacheSet(KEYS_CACHE_KEY, currentKeyPair, KEY_TTL);
    return currentKeyPair;
  }

  if (config.nodeEnv === 'production') {
    throw new Error(
      'JWT signing keys are not configured: set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY in production. ' +
        'Falling back to in-memory key generation is unsafe because the keys are not durable — ' +
        'losing the cache (e.g. a Redis restart) regenerates them and invalidates every issued token.',
    );
  }

  currentKeyPair = generateRsaKeyPair();
  await cacheSet(KEYS_CACHE_KEY, currentKeyPair, KEY_TTL);
  return currentKeyPair;
}

/**
 * Generate a new RSA key pair and make it the active signing key.
 * Retains the previous key pair in the grace key ring so active tokens
 * signed with the previous kid remain valid during grace periods (#887).
 */
export async function rotateKeys(): Promise<KeyPair> {
  if (currentKeyPair) {
    graceKeyPairs.set(currentKeyPair.kid, currentKeyPair);
  }
  currentKeyPair = generateRsaKeyPair();
  await cacheSet(KEYS_CACHE_KEY, currentKeyPair, KEY_TTL);
  return currentKeyPair;
}

export function getGraceKeyPairs(): KeyPair[] {
  return Array.from(graceKeyPairs.values());
}

export async function getKeyPairForKid(kid?: string): Promise<KeyPair | null> {
  const current = await getOrCreateKeyPair();
  if (!kid || current.kid === kid) return current;
  return graceKeyPairs.get(kid) ?? null;
}

/** Convert PEM public key to JWKS JWK format */
function pemToJwk(publicKeyPem: string, kid: string): object {
  const pubKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const n = forge.util.encode64(forge.util.hexToBytes(pubKey.n.toString(16).padStart(2, '0')));
  const e = forge.util.encode64(forge.util.hexToBytes(pubKey.e.toString(16).padStart(2, '0')));
  // Convert to URL-safe base64
  const toB64Url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return {
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
    kid,
    n: toB64Url(n),
    e: toB64Url(e),
  };
}

export async function getJwks(): Promise<{ keys: object[] }> {
  const kp = await getOrCreateKeyPair();
  const keys = [pemToJwk(kp.publicKeyPem, kp.kid)];
  for (const graceKp of graceKeyPairs.values()) {
    keys.push(pemToJwk(graceKp.publicKeyPem, graceKp.kid));
  }
  return { keys };
}
