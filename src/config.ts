import * as dotenv from 'dotenv';
import { z } from 'zod';
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

/**
 * Parse and validate a numeric environment variable with a default value
 */
function parseNumericEnv(
  name: string,
  envValue: string | undefined,
  defaultValue: number,
  schema: z.ZodNumber,
): number {
  // If no value provided, use default
  if (!envValue || envValue.trim() === '') {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);

  // Check if parsing resulted in NaN
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid value for ${name}: "${envValue}" cannot be parsed as a number. ` +
        `Expected a valid integer. Using default value ${defaultValue} is recommended.`,
    );
  }

  // Validate against Zod schema
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message).join(', ');
    throw new Error(
      `Invalid value for ${name}: ${parsed}. ${issues}. ` +
        `Valid range should match the schema constraints.`,
    );
  }

  return parsed;
}

// Define Zod schemas for validation
const envSchemas = {
  port: z.number().int().positive().max(65535, 'Port must be between 1 and 65535'),
  indexerStartLedger: z.number().int().min(0, 'Indexer start ledger must be non-negative'),
  indexerPollIntervalMs: z
    .number()
    .int()
    .positive()
    .min(100, 'Poll interval must be at least 100ms'),
  indexerBatchSize: z.number().int().positive().max(1000, 'Batch size must be between 1 and 1000'),
  indexerCatchupWorkers: z
    .number()
    .int()
    .min(1)
    .max(32, 'Catchup workers must be between 1 and 32'),
  microBlockPollIntervalMs: z
    .number()
    .int()
    .positive()
    .min(100, 'Micro-block poll interval must be at least 100ms'),
  rateLimitWindowMs: z
    .number()
    .int()
    .positive()
    .min(1000, 'Rate limit window must be at least 1000ms'),
  rateLimitMax: z.number().int().positive().min(1, 'Rate limit max must be at least 1'),
};

const profile: NetworkProfile = getProfile(network);

// Parse and validate all numeric configuration values
let port: number;
let indexerStartLedger: number;
let indexerPollIntervalMs: number;
let indexerBatchSize: number;
let indexerCatchupWorkers: number;
let microBlockPollIntervalMs: number;
let rateLimitWindowMs: number;
let rateLimitMax: number;

try {
  port = parseNumericEnv('PORT', process.env.PORT, 3000, envSchemas.port);
  indexerStartLedger = parseNumericEnv(
    'INDEXER_START_LEDGER',
    process.env.INDEXER_START_LEDGER,
    0,
    envSchemas.indexerStartLedger,
  );
  indexerPollIntervalMs = parseNumericEnv(
    'INDEXER_POLL_INTERVAL_MS',
    process.env.INDEXER_POLL_INTERVAL_MS,
    5000,
    envSchemas.indexerPollIntervalMs,
  );
  indexerBatchSize = parseNumericEnv(
    'INDEXER_BATCH_SIZE',
    process.env.INDEXER_BATCH_SIZE,
    100,
    envSchemas.indexerBatchSize,
  );
  indexerCatchupWorkers = parseNumericEnv(
    'INDEXER_CATCHUP_WORKERS',
    process.env.INDEXER_CATCHUP_WORKERS,
    4,
    envSchemas.indexerCatchupWorkers,
  );
  microBlockPollIntervalMs = parseNumericEnv(
    'MICRO_BLOCK_POLL_INTERVAL_MS',
    process.env.MICRO_BLOCK_POLL_INTERVAL_MS,
    2500,
    envSchemas.microBlockPollIntervalMs,
  );
  rateLimitWindowMs = parseNumericEnv(
    'RATE_LIMIT_WINDOW_MS',
    process.env.RATE_LIMIT_WINDOW_MS,
    60000,
    envSchemas.rateLimitWindowMs,
  );
  rateLimitMax = parseNumericEnv(
    'RATE_LIMIT_MAX',
    process.env.RATE_LIMIT_MAX,
    100,
    envSchemas.rateLimitMax,
  );
} catch (error) {
  // Format error message for actionable feedback
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('❌ CONFIGURATION ERROR: Invalid environment variable');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.error(errorMessage);
  console.error('\n📋 Action required:');
  console.error('  1. Check your .env file or environment variables');
  console.error('  2. Ensure numeric values are valid integers');
  console.error('  3. Verify values are within acceptable ranges');
  console.error('  4. See .env.example for reference values\n');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(1);
}

export const config = {
  // ── Server ───────────────────────────────────────────────────────────────
  port,
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
  indexerStartLedger,
  indexerPollIntervalMs,
  indexerBatchSize,
  indexerCatchupWorkers,

  // ── Micro-block sync (2.5 s block close times) ────────────────────────────
  microBlockSyncEnabled: (process.env.MICRO_BLOCK_SYNC_ENABLED ?? 'true') !== 'false',
  microBlockPollIntervalMs,

  // ── Rate limiting ─────────────────────────────────────────────────────────
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
  rateLimitPublicMax: parseInt(process.env.RATE_LIMIT_PUBLIC_MAX ?? '100'),
  rateLimitDeveloperMax: parseInt(process.env.RATE_LIMIT_DEVELOPER_MAX ?? '300'),
  rateLimitPremiumMax: parseInt(process.env.RATE_LIMIT_PREMIUM_MAX ?? '1000'),
  rateLimitPublicWindowMs: parseInt(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS ?? '60000'),
  rateLimitDeveloperWindowMs: parseInt(process.env.RATE_LIMIT_DEVELOPER_WINDOW_MS ?? '60000'),
  rateLimitPremiumWindowMs: parseInt(process.env.RATE_LIMIT_PREMIUM_WINDOW_MS ?? '60000'),
  rateLimitAdaptiveEnabled: process.env.RATE_LIMIT_ADAPTIVE_ENABLED !== 'false',
  rateLimitAdaptiveThreshold: parseFloat(process.env.RATE_LIMIT_ADAPTIVE_THRESHOLD ?? '0.85'),
  rateLimitAdaptiveMultiplier: parseFloat(process.env.RATE_LIMIT_ADAPTIVE_MULTIPLIER ?? '0.75'),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  // ── Exports ───────────────────────────────────────────────────────────────
  exportDir: process.env.EXPORT_DIR ?? '/tmp/soroban-exports',

  // ── Predictive analytics ──────────────────────────────────────────────────
  forecastMode: process.env.FORECAST_MODE === 'production' ? 'production' : 'demo',
  forecastSeed: parseInt(process.env.FORECAST_SEED ?? '42', 10),
} as const;
