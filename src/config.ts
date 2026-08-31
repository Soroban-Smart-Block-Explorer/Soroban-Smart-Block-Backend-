import * as dotenv from 'dotenv';
import { z } from 'zod';
import { getProfile } from './profiles';
import { logger } from './logger';

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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  TRUST_PROXY: z.string().optional(),

  STELLAR_NETWORK: z.string().default('testnet'),

  INDEXER_START_LEDGER: z.coerce.number().int().min(0).default(0),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().min(100).default(5000),
  INDEXER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(100),
  INDEXER_CATCHUP_WORKERS: z.coerce.number().int().min(1).max(32).default(4),
  INDEXER_REORG_PROTECTION_DEPTH: z.coerce.number().int().positive().default(100),

  MICRO_BLOCK_SYNC_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(true),
  MICRO_BLOCK_POLL_INTERVAL_MS: z.coerce.number().int().positive().min(100).default(2500),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().min(1000).default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().min(1).default(100),
  RATE_LIMIT_PUBLIC_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_DEVELOPER_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_PREMIUM_MAX: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_PUBLIC_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_DEVELOPER_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_PREMIUM_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_ADAPTIVE_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v !== 'false' && v !== false)
    .default(true),
  RATE_LIMIT_ADAPTIVE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  RATE_LIMIT_ADAPTIVE_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.75),

  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  EXPORT_DIR: z.string().default('/tmp/soroban-exports'),
  FORECAST_MODE: z.enum(['production', 'demo']).default('demo'),
  FORECAST_SEED: z.coerce.number().int().default(42),

  TIMEOUT_FAST_MS: z.coerce.number().int().positive().default(5000),
  TIMEOUT_NORMAL_MS: z.coerce.number().int().positive().default(30000),
  TIMEOUT_LONG_MS: z.coerce.number().int().positive().default(300000),
  TIMEOUT_EXTENDED_MS: z.coerce.number().int().positive().default(900000),

  COOKIE_SECRET: z.string().default(''),
  COOKIE_EXPIRES_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v !== 'false' && v !== false)
    .default(true),
  COOKIE_HTTP_ONLY: z
    .union([z.boolean(), z.string()])
    .transform((v) => v !== 'false' && v !== false)
    .default(true),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  COOKIE_NAME: z.string().default('soroban_session'),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  STATE_DUMP_PATH: z.string().default('/tmp/state'),

  DISABLE_INDEXER: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  ADMIN_API_KEY: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  JWT_PREVIOUS_SECRETS: z.string().optional(),
  WS_SECRET: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),

  // #907 — /metrics access control. Comma-separated IP/CIDR allowlist and/or
  // a shared bearer token; see src/middleware/metricsAuth.ts.
  METRICS_ALLOWED_IPS: z.string().default(''),
  METRICS_TOKEN: z.string().optional(),
  METRICS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  METRICS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // #906 — worker/background-job health thresholds, see src/health.ts and
  // src/scheduler/cron-scheduler.ts.
  WORKER_STALE_INTERVAL_MULTIPLIER: z.coerce.number().positive().default(3),
  WORKER_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
});

let parsedEnv: z.infer<typeof envSchema>;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  // Format error message for actionable feedback
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.error('❌ CONFIGURATION ERROR: Invalid environment variable');
  logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  logger.error(errorMessage);
  logger.error('\n📋 Action required:');
  logger.error('  1. Check your .env file or environment variables');
  logger.error('  2. Ensure numeric values are valid integers');
  logger.error('  3. Verify values are within acceptable ranges');
  logger.error('  4. See .env.example for reference values\n');
  logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (process.env.NODE_ENV === 'test') {
    throw error;
  }
  process.exit(1);
}

export function assertConfig() {
  if (parsedEnv.NODE_ENV === 'production') {
    const missing = [];
    if (!parsedEnv.ADMIN_API_KEY) missing.push('ADMIN_API_KEY');
    if (!parsedEnv.JWT_SECRET) missing.push('JWT_SECRET');
    if (!parsedEnv.WS_SECRET) missing.push('WS_SECRET');
    if (!parsedEnv.WEBHOOK_SECRET) missing.push('WEBHOOK_SECRET');

    if (missing.length > 0) {
      const errString = `Missing required production variables: ${missing.join(', ')}`;
      logger.error(`\n❌ ${errString}`);
      if (process.env.NODE_ENV === 'test') {
        throw new Error(errString);
      }
      process.exit(1);
    }
  }
}

const profile = getProfile(parsedEnv.STELLAR_NETWORK);

export const config = {
  // ── Server ───────────────────────────────────────────────────────────────
  port: parsedEnv.PORT,
  nodeEnv: parsedEnv.NODE_ENV,
  trustProxy: parseTrustProxy(parsedEnv.TRUST_PROXY),

  adminApiKey: parsedEnv.ADMIN_API_KEY,
  jwtSecret: parsedEnv.JWT_SECRET,
  jwtPreviousSecrets: parsedEnv.JWT_PREVIOUS_SECRETS,
  wsSecret: parsedEnv.WS_SECRET,
  webhookSecret: parsedEnv.WEBHOOK_SECRET,

  profile,
  stellarNetwork: profile.name,
  stellarRpcUrl: profile.rpcUrl,
  stellarRpcWsUrl: profile.rpcWsUrl,
  horizonUrl: profile.horizonUrl,
  networkPassphrase: profile.networkPassphrase,
  apiSubdomain: profile.apiSubdomain,
  cacheUrl: profile.cacheUrl,
  cacheMode: profile.cacheMode,

  // ── Database (resolved from profile) ─────────────────────────────────────
  databaseUrl: profile.databaseUrl,
  readReplicaUrl: profile.readReplicaUrl,

  disableIndexer: parsedEnv.DISABLE_INDEXER,
  indexerStartLedger: parsedEnv.INDEXER_START_LEDGER,
  indexerPollIntervalMs: parsedEnv.INDEXER_POLL_INTERVAL_MS,
  indexerBatchSize: parsedEnv.INDEXER_BATCH_SIZE,
  indexerCatchupWorkers: parsedEnv.INDEXER_CATCHUP_WORKERS,
  indexerReorgProtectionDepth: parsedEnv.INDEXER_REORG_PROTECTION_DEPTH,

  microBlockSyncEnabled: parsedEnv.MICRO_BLOCK_SYNC_ENABLED,
  microBlockPollIntervalMs: parsedEnv.MICRO_BLOCK_POLL_INTERVAL_MS,

  rateLimitWindowMs: parsedEnv.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: parsedEnv.RATE_LIMIT_MAX,
  rateLimitPublicMax: parsedEnv.RATE_LIMIT_PUBLIC_MAX,
  rateLimitDeveloperMax: parsedEnv.RATE_LIMIT_DEVELOPER_MAX,
  rateLimitPremiumMax: parsedEnv.RATE_LIMIT_PREMIUM_MAX,
  rateLimitPublicWindowMs: parsedEnv.RATE_LIMIT_PUBLIC_WINDOW_MS,
  rateLimitDeveloperWindowMs: parsedEnv.RATE_LIMIT_DEVELOPER_WINDOW_MS,
  rateLimitPremiumWindowMs: parsedEnv.RATE_LIMIT_PREMIUM_WINDOW_MS,
  rateLimitAdaptiveEnabled: parsedEnv.RATE_LIMIT_ADAPTIVE_ENABLED,
  rateLimitAdaptiveThreshold: parsedEnv.RATE_LIMIT_ADAPTIVE_THRESHOLD,
  rateLimitAdaptiveMultiplier: parsedEnv.RATE_LIMIT_ADAPTIVE_MULTIPLIER,

  openAiApiKey: parsedEnv.OPENAI_API_KEY,
  anthropicApiKey: parsedEnv.ANTHROPIC_API_KEY,

  exportDir: parsedEnv.EXPORT_DIR,

  forecastMode: parsedEnv.FORECAST_MODE,
  forecastSeed: parsedEnv.FORECAST_SEED,

  timeoutFastMs: parsedEnv.TIMEOUT_FAST_MS,
  timeoutNormalMs: parsedEnv.TIMEOUT_NORMAL_MS,
  timeoutLongMs: parsedEnv.TIMEOUT_LONG_MS,
  timeoutExtendedMs: parsedEnv.TIMEOUT_EXTENDED_MS,

  cookieSecret: parsedEnv.COOKIE_SECRET,
  cookieExpiresMs: parsedEnv.COOKIE_EXPIRES_MS,
  cookieSecure: parsedEnv.COOKIE_SECURE,
  cookieHttpOnly: parsedEnv.COOKIE_HTTP_ONLY,
  cookieSameSite: parsedEnv.COOKIE_SAME_SITE,
  cookieName: parsedEnv.COOKIE_NAME,

  shutdownTimeoutMs: parsedEnv.SHUTDOWN_TIMEOUT_MS,
  stateDumpPath: parsedEnv.STATE_DUMP_PATH,

  metricsAllowedIps: parsedEnv.METRICS_ALLOWED_IPS,
  metricsToken: parsedEnv.METRICS_TOKEN,
  metricsRateLimitMax: parsedEnv.METRICS_RATE_LIMIT_MAX,
  metricsRateLimitWindowMs: parsedEnv.METRICS_RATE_LIMIT_WINDOW_MS,

  workerStaleIntervalMultiplier: parsedEnv.WORKER_STALE_INTERVAL_MULTIPLIER,
  workerMaxConsecutiveFailures: parsedEnv.WORKER_MAX_CONSECUTIVE_FAILURES,
} as const;
