import * as dotenv from 'dotenv';
import { getProfile, type NetworkProfile } from './profiles';

// Load the profile-specific env file first, then fall back to .env
const network = process.env.STELLAR_NETWORK ?? 'testnet';
dotenv.config({ path: `.env.${network}` });
dotenv.config(); // base .env fills any remaining gaps

function parseTrustProxy(value: string | undefined): boolean | string | string[] {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const profile: NetworkProfile = getProfile(network);

export const config = {
  // ── Server ───────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT ?? '3000'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // ── Active network profile ────────────────────────────────────────────────
  profile,
  stellarNetwork: profile.name,
  stellarRpcUrl: profile.rpcUrl,
  stellarRpcWsUrl: profile.rpcWsUrl,
  horizonUrl: profile.horizonUrl,
  networkPassphrase: profile.networkPassphrase,
  apiSubdomain: profile.apiSubdomain,
  cacheUrl: profile.cacheUrl,

  // ── Database (resolved from profile) ─────────────────────────────────────
  databaseUrl: profile.databaseUrl,
  readReplicaUrl: profile.readReplicaUrl,

  // ── Indexer ───────────────────────────────────────────────────────────────
  indexerStartLedger: parseInt(process.env.INDEXER_START_LEDGER ?? '0'),
  indexerPollIntervalMs: parseInt(process.env.INDEXER_POLL_INTERVAL_MS ?? '5000'),
  indexerBatchSize: parseInt(process.env.INDEXER_BATCH_SIZE ?? '100'),
  indexerCatchupWorkers: Math.max(1, parseInt(process.env.INDEXER_CATCHUP_WORKERS ?? '4')),

  // ── Micro-block sync (2.5 s block close times) ────────────────────────────
  microBlockSyncEnabled: (process.env.MICRO_BLOCK_SYNC_ENABLED ?? 'true') !== 'false',
  microBlockPollIntervalMs: parseInt(process.env.MICRO_BLOCK_POLL_INTERVAL_MS ?? '2500'),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
};
