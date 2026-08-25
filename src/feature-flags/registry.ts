/**
 * Feature flag registry
 *
 * Declarative list of every feature flag the platform knows about. Each entry
 * carries:
 *  - `envVar`            — legacy/per-environment bootstrap env var (e.g. the
 *                          ENABLE_* vars that previously gated these services).
 *  - `requiredTables`    — Postgres tables that must exist for the feature to
 *                          be *available* (schema availability). If any table is
 *                          missing the feature reports "schema unavailable" and
 *                          is never started, regardless of the toggle state.
 *  - `defaultEnabled`    — built-in fallback used when no DB row exists and the
 *                          env var is unset. Schema-gated features default off.
 *  - `rolloutPercent`    — built-in gradual-rollout target (0-100) when no DB
 *                          row exists.
 *
 * The DB row (prisma FeatureFlag) is the source of truth once it exists; the
 * values here are only the fallback until the row is seeded (see
 * FeatureFlagStore.ensureRegisteredFlags).
 */

export type FlagScopeType = 'environment' | 'developer';

export interface FlagDefinition {
  key: string;
  description: string;
  /** Legacy per-environment env var (checked at eval time). */
  envVar?: string;
  /** Tables that must exist for the feature to be available. */
  requiredTables?: string[];
  /** Fallback when no DB row exists and no env var is set. */
  defaultEnabled: boolean;
  /** Fallback rollout target (0-100) when no DB row exists. */
  rolloutPercent?: number;
}

export const FEATURE_FLAG_DEFINITIONS: FlagDefinition[] = [
  {
    key: 'privacyWs',
    description:
      'Privacy WebSocket broadcaster (/ws/v1/privacy and /ws/v1/privacy/alerts); streams privacy-protocol transactions and anomaly alerts.',
    envVar: 'ENABLE_PRIVACY_WS',
    requiredTables: ['_privacy_transactions'],
    defaultEnabled: false,
  },
  {
    key: 'composabilityWs',
    description:
      'Composability WebSocket broadcaster (/ws/composability/exploits); broadcasts cross-contract exploit-pattern alerts.',
    envVar: 'ENABLE_COMPOSABILITY_WS',
    defaultEnabled: false,
  },
  {
    key: 'arbitrageWs',
    description:
      'Arbitrage WebSocket broadcaster (/ws/arbitrage/opportunities); streams arbitrage opportunities detected by the scanner.',
    envVar: 'ENABLE_ARBITRAGE_WS',
    requiredTables: ['_arbitrage_opportunities'],
    defaultEnabled: false,
  },
  {
    key: 'poolMonitor',
    description:
      'Pool price monitor; polls active DexPool rows, writes PoolPrice rows, computes TWAP, flags cross-DEX price deviations.',
    envVar: 'ENABLE_POOL_MONITOR',
    requiredTables: ['_dex_pools', '_pool_prices', '_price_deviations'],
    defaultEnabled: false,
  },
  {
    key: 'arbitrageScanner',
    description:
      'Arbitrage scanner; runs direct + triangular arbitrage detection and persists ArbitrageOpportunity rows.',
    envVar: 'ENABLE_ARBITRAGE_SCANNER',
    requiredTables: ['_dex_pools', '_pool_prices', '_arbitrage_opportunities'],
    defaultEnabled: false,
  },
  {
    key: 'feeAggregator',
    description:
      'Fee aggregator; classifies on-chain fee events into FeeEvent rows and aggregates ProtocolRevenue / YieldSnapshot buckets.',
    envVar: 'ENABLE_FEE_AGGREGATOR',
    requiredTables: [
      '_fee_events',
      '_protocol_revenues',
      '_yield_snapshots',
      '_protocol_profiles',
      '_revenue_alerts',
    ],
    defaultEnabled: false,
  },
];

const byKey = new Map(FEATURE_FLAG_DEFINITIONS.map((def) => [def.key, def]));

export function findFlagDefinition(key: string): FlagDefinition | undefined {
  return byKey.get(key);
}

export function listFlagDefinitions(): FlagDefinition[] {
  return FEATURE_FLAG_DEFINITIONS;
}

/** Generic env-var convention for flags that don't declare a legacy var: FF_<KEY>. */
export function envVarFor(def: FlagDefinition): string {
  if (def.envVar) return def.envVar;
  return `FF_${def.key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}
