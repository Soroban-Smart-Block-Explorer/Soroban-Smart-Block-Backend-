/**
 * Upgrade detection (Phase 1) — recognise contract WASM upgrades from indexed
 * events, extract the upgrader and previous/new WASM hashes, best-effort fetch
 * the bytecode for diffing, and hand off to the governance-intelligence
 * orchestrator. Wired into the event ingestion pipeline.
 */

import { xdr } from '@stellar/stellar-sdk';
import { rpc } from './rpc';
import { recordUpgradeWithIntelligence } from './upgrade-governance';
import { triggerUpgradeAudit } from './audit-pipeline';

/** Event topic symbols / types that signal a contract code upgrade. */
const UPGRADE_SYMBOLS = new Set<string>([
  'upgrade',
  'upgraded',
  'set_wasm',
  'update_wasm',
  'wasm_updated',
  'code_updated',
  'contract_upgraded',
  'migrate',
  'migrated',
]);

/**
 * Cheap gate used by the ingestion pipeline to decide whether an event is worth
 * the contract lookup + full upgrade-handling path. Exported so callers can
 * avoid that work for the overwhelming majority of non-upgrade events.
 */
export function looksLikeUpgrade(eventType: string | null, topicSymbol: string | null): boolean {
  const symbol = (topicSymbol ?? eventType ?? '').toLowerCase();
  if (!symbol) return false;
  return UPGRADE_SYMBOLS.has(symbol) || symbol.includes('upgrade') || symbol.includes('wasm');
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return undefined;
}

/** Pull the new WASM hash out of decoded event fields, normalising to hex. */
function extractNewHash(decoded: Record<string, unknown>, topics: string[]): string | undefined {
  const candidate =
    asString(decoded.new_wasm_hash) ??
    asString(decoded.newWasmHash) ??
    asString(decoded.wasm_hash) ??
    asString(decoded.wasmHash) ??
    asString(decoded.new_hash) ??
    asString(decoded.newHash) ??
    asString(decoded.hash) ??
    asString((decoded.data as Record<string, unknown> | undefined)?.wasm_hash);
  if (candidate) return candidate.replace(/^0x/, '').toLowerCase();
  return undefined;
}

/** Pull the upgrading authority out of decoded event fields. */
function extractUpgrader(decoded: Record<string, unknown>, sourceAccount: string): string {
  return (
    asString(decoded.admin) ??
    asString(decoded.caller) ??
    asString(decoded.by) ??
    asString(decoded.sender) ??
    asString(decoded.from) ??
    asString(decoded.authority) ??
    sourceAccount
  );
}

/**
 * Fetch contract WASM bytecode by its hash from the live ledger. Returns null
 * when the code entry is unavailable (evicted/archived) or on any RPC error —
 * the diff is optional and must never block upgrade recording.
 */
export async function fetchWasmByHash(hashHex: string): Promise<Buffer | null> {
  try {
    const hash = Buffer.from(hashHex, 'hex');
    if (hash.length !== 32) return null;
    const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }));
    const response = await rpc.getLedgerEntries(key);
    const entry = response.entries?.[0];
    if (!entry) return null;
    const code = (entry.val as xdr.LedgerEntryData).contractCode().code();
    return Buffer.from(code);
  } catch {
    return null;
  }
}

export interface UpgradeEventInput {
  contractAddress: string;
  eventType: string | null;
  topicSymbol: string | null;
  decoded: Record<string, unknown> | null;
  topics: string[];
  transactionHash: string;
  sourceAccount: string;
  ledgerSequence: number;
  ledgerCloseTime: Date;
  previousHash?: string | null;
}

/**
 * Handle a single decoded event: if it is an upgrade and carries a new WASM
 * hash, fetch the relevant bytecode and record the upgrade with full
 * governance intelligence. No-op for non-upgrade events.
 */
export async function handleUpgradeEvent(input: UpgradeEventInput): Promise<void> {
  if (!looksLikeUpgrade(input.eventType, input.topicSymbol)) return;
  const decoded = input.decoded ?? {};
  const newWasmHash = extractNewHash(decoded, input.topics);
  if (!newWasmHash) return;

  const upgrader = extractUpgrader(decoded, input.sourceAccount);

  // Best-effort bytecode fetch for the WASM diff. Only diff when we can read
  // both versions; a partial fetch still records the upgrade without a diff.
  const newWasm = await fetchWasmByHash(newWasmHash);
  const previousWasm = input.previousHash ? await fetchWasmByHash(input.previousHash) : null;
  const canDiff = Boolean(newWasm && (input.previousHash ? previousWasm : true));

  await recordUpgradeWithIntelligence({
    contractAddress: input.contractAddress,
    newWasmHash,
    ledgerSequence: input.ledgerSequence,
    ledgerCloseTime: input.ledgerCloseTime,
    transactionHash: input.transactionHash,
    upgrader,
    previousWasm: canDiff ? previousWasm : undefined,
    newWasm: canDiff ? newWasm : undefined,
  });

  // Immediately trigger a full re-audit now that a new upgrade is recorded
  triggerUpgradeAudit(input.contractAddress);
}
