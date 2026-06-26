/**
 * Issue #51 — XDR Upgrades & Horizon Deprecation Guard
 *
 * Monitors the Stellar/Soroban protocol version and gates XDR parsing
 * behind version-aware try/catch blocks so upcoming testnet upgrades
 * don't crash the mainnet ingestion service.
 */
import { rpc } from './rpc';

// ── Protocol version registry ────────────────────────────────────────────────

/**
 * Known protocol versions and the features they introduce.
 * Update this map when new protocol versions are announced.
 */
const PROTOCOL_FEATURES: Record<number, string[]> = {
  20: ['soroban_v1', 'invoke_host_function'],
  21: ['soroban_v2', 'transaction_meta_v3', 'diagnostic_events'],
  22: ['soroban_v3', 'parallel_soroban'], // anticipated
};

/** Minimum supported protocol version for Soroban features */
const MIN_SOROBAN_PROTOCOL = 20;

// ── State ────────────────────────────────────────────────────────────────────

let cachedProtocolVersion: number | null = null;
let lastVersionCheck = 0;
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Version detection ────────────────────────────────────────────────────────

/**
 * Fetch the current protocol version from the RPC node.
 * Caches the result for VERSION_CACHE_TTL_MS to avoid hammering the RPC.
 */
export async function getProtocolVersion(): Promise<number> {
  const now = Date.now();
  if (cachedProtocolVersion !== null && now - lastVersionCheck < VERSION_CACHE_TTL_MS) {
    return cachedProtocolVersion;
  }

  try {
    const info = await rpc.getLatestLedger();
    const version = Number((info as any).protocolVersion ?? (info as any).protocol_version ?? 0);
    if (version > 0) {
      cachedProtocolVersion = version;
      lastVersionCheck = now;
      console.log(`[protocol-guard] Protocol version: ${version}`);
    }
    return version;
  } catch (err) {
    console.warn('[protocol-guard] Could not fetch protocol version:', err);
    return cachedProtocolVersion ?? 0;
  }
}

/**
 * Check whether a specific feature is available in the current protocol.
 */
export async function isFeatureAvailable(feature: string): Promise<boolean> {
  const version = await getProtocolVersion();
  for (const [v, features] of Object.entries(PROTOCOL_FEATURES)) {
    if (Number(v) <= version && features.includes(feature)) return true;
  }
  return false;
}

// ── Version-gated XDR parsing ────────────────────────────────────────────────

/**
 * Safely execute an XDR parsing function with version-aware error handling.
 * If the parse fails due to a structural mismatch (likely a protocol upgrade),
 * logs a warning instead of crashing and returns the fallback value.
 *
 * @param fn - The XDR parsing function to execute
 * @param fallback - Value to return if parsing fails
 * @param context - Description for logging (e.g. "TransactionMeta v3")
 */
export function safeXdrParse<T>(fn: () => T, fallback: T, context = 'XDR'): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish protocol-upgrade errors from genuine bugs
    const isStructuralError =
      msg.includes('unknown arm') ||
      msg.includes('invalid switch') ||
      msg.includes('XDR') ||
      msg.includes('decode') ||
      msg.includes('switch');

    if (isStructuralError) {
      console.warn(
        `[protocol-guard] ${context} parse failed — possible protocol upgrade. ` +
          `Skipping gracefully. Error: ${msg}`,
      );
    } else {
      console.error(`[protocol-guard] ${context} parse error: ${msg}`);
    }
    return fallback;
  }
}

// ── Protocol version monitor ─────────────────────────────────────────────────

export interface ProtocolStatus {
  currentVersion: number;
  minSupported: number;
  isSupported: boolean;
  knownFeatures: string[];
  warning: string | null;
}

/**
 * Get the current protocol status, including support warnings.
 */
export async function getProtocolStatus(): Promise<ProtocolStatus> {
  const currentVersion = await getProtocolVersion();
  const isSupported = currentVersion >= MIN_SOROBAN_PROTOCOL;

  const knownFeatures: string[] = [];
  for (const [v, features] of Object.entries(PROTOCOL_FEATURES)) {
    if (Number(v) <= currentVersion) knownFeatures.push(...features);
  }

  let warning: string | null = null;
  const maxKnown = Math.max(...Object.keys(PROTOCOL_FEATURES).map(Number));

  if (currentVersion > maxKnown) {
    warning =
      `Protocol version ${currentVersion} is newer than the highest known version ` +
      `(${maxKnown}). XDR structures may have changed — some parsing may fail gracefully.`;
    console.warn(`[protocol-guard] ⚠️  ${warning}`);
  } else if (!isSupported) {
    warning = `Protocol version ${currentVersion} is below minimum supported (${MIN_SOROBAN_PROTOCOL})`;
  }

  return {
    currentVersion,
    minSupported: MIN_SOROBAN_PROTOCOL,
    isSupported,
    knownFeatures,
    warning,
  };
}

/**
 * Start periodic protocol version monitoring.
 * Logs a warning if the version advances beyond known versions.
 */
export function startProtocolMonitor(): NodeJS.Timeout {
  const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  const check = async () => {
    try {
      const status = await getProtocolStatus();
      if (status.warning) {
        console.warn(`[protocol-guard] Protocol warning: ${status.warning}`);
      }
    } catch (err) {
      console.error('[protocol-guard] Monitor check failed:', err);
    }
  };

  // Run immediately
  check();

  return setInterval(check, CHECK_INTERVAL_MS);
}

/**
 * Wrap a Horizon API call with a deprecation guard.
 * If the endpoint returns a 410 Gone or similar deprecation signal,
 * logs a warning and returns the fallback instead of throwing.
 */
export async function horizonGuard<T>(
  fn: () => Promise<T>,
  fallback: T,
  endpointName: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    if (status === 410 || status === 404 || status === 501) {
      console.warn(
        `[protocol-guard] Horizon endpoint "${endpointName}" returned ${status} — ` +
          `it may be deprecated. Using fallback.`,
      );
      return fallback;
    }
    throw err;
  }
}
