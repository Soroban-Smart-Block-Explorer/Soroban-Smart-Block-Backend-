/**
 * Account Abstraction Classifier
 *
 * Detects and classifies smart wallets from transaction auth data and WASM
 * bytecode analysis. Handles all wallet types required by the AA spec:
 *   multi_sig | social_recovery | session_key | sponsored | passkey | hybrid | custom
 */

import { xdr, StrKey } from '@stellar/stellar-sdk';
import type { ParsedAuth } from './xdr-parser';

// ── Known AA function signatures ──────────────────────────────────────────────

/** Functions that indicate a contract is a smart wallet / account contract. */
const AA_FUNCTION_NAMES = new Set([
  '__check_auth',
  'validate_signature',
  'exec',
  'execute',
  'add_signer',
  'remove_signer',
  'set_threshold',
  'add_guardian',
  'remove_guardian',
  'social_recover',
  'initiate_recovery',
  'complete_recovery',
  'add_session_key',
  'revoke_session_key',
  'authorize_session',
  'verify_passkey',
  'webauthn_verify',
  'fido2_verify',
]);

// Passkey / WebAuthn byte-sequence indicators in WASM section names or imports
const PASSKEY_INDICATORS = ['webauthn', 'fido2', 'passkey', 'secp256r1', 'p256'];

// ── Result types ──────────────────────────────────────────────────────────────

export type WalletType =
  | 'multi_sig'
  | 'social_recovery'
  | 'session_key'
  | 'sponsored'
  | 'passkey'
  | 'hybrid'
  | 'custom';

export interface WalletClassification {
  walletType: WalletType;
  signerCount: number | null;
  threshold: number | null;
  guardians: string[];
  sessionKeys: SessionKeyInfo[];
  authMethods: string[];
  isSmartWallet: boolean;
}

export interface SessionKeyInfo {
  address: string;
  expiryLedger: number | null;
}

export interface SponsorInfo {
  isFeeSponsored: boolean;
  sponsorAccount: string | null;
  sourceAccount: string | null;
}

// ── Source account helpers ────────────────────────────────────────────────────

/**
 * Returns true when the address is a Stellar contract address (C…) rather
 * than a classic G-account or M-muxed address.
 */
export function isContractAddress(address: string): boolean {
  try {
    return address.startsWith('C') && StrKey.isValidContract(address);
  } catch {
    return false;
  }
}

/**
 * Extract sponsor and source from a raw transaction envelope.
 * A fee-bump envelope has an explicit fee-source that differs from the inner tx.
 */
export function extractSponsorInfo(rawXdr: string): SponsorInfo {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    if (envelope.switch().name === 'envelopeTypeTxFeeBump') {
      const feeBump = envelope.feeBump();
      const feeSource = feeBump.tx().feeSource();
      const sponsorAccount = StrKey.encodeEd25519PublicKey(feeSource.ed25519());
      const innerTx = feeBump.tx().innerTx().v1().tx();
      const sourceAccount = StrKey.encodeEd25519PublicKey(innerTx.sourceAccount().ed25519());
      return {
        isFeeSponsored: sponsorAccount !== sourceAccount,
        sponsorAccount,
        sourceAccount,
      };
    }
  } catch {
    // not a fee-bump or parse error
  }
  return { isFeeSponsored: false, sponsorAccount: null, sourceAccount: null };
}

// ── Auth-tree analysis ────────────────────────────────────────────────────────

interface AuthAnalysis {
  signerCount: number;
  addresses: string[];
  hasContractAuth: boolean;
  hasFunctionNames: Set<string>;
  subCallDepth: number;
}

function analyzeAuthTree(entries: ParsedAuth[]): AuthAnalysis {
  const addresses = new Set<string>();
  const hasFunctionNames = new Set<string>();
  let hasContractAuth = false;
  let maxDepth = 0;

  function walk(entry: ParsedAuth, depth: number) {
    maxDepth = Math.max(maxDepth, depth);
    addresses.add(entry.address);
    if (entry.type === 'contract') hasContractAuth = true;
    for (const sub of entry.subInvocations) {
      hasFunctionNames.add(sub.functionName);
      // sub-invocations don't have further auth entries but track the fns
    }
  }

  for (const e of entries) walk(e, 1);

  return {
    signerCount: addresses.size,
    addresses: [...addresses],
    hasContractAuth,
    hasFunctionNames,
    subCallDepth: maxDepth,
  };
}

// ── WASM-level AA indicators ──────────────────────────────────────────────────

/**
 * Scan a WASM buffer's custom sections and import section for AA function
 * names exported by the contract. This is a lightweight string scan — we look
 * for the function name bytes in the export/custom sections without a full
 * parse, which is sufficient for classification.
 */
export function extractWasmAaIndicators(wasm: Buffer): {
  exportedFunctions: string[];
  hasPasskeyIndicators: boolean;
} {
  const exportedFunctions: string[] = [];
  let hasPasskeyIndicators = false;

  // Fast string scan: look for known AA function names as UTF-8 substrings
  const text = wasm.toString('binary');
  for (const fn of AA_FUNCTION_NAMES) {
    if (text.includes(fn)) exportedFunctions.push(fn);
  }
  for (const indicator of PASSKEY_INDICATORS) {
    if (text.toLowerCase().includes(indicator)) {
      hasPasskeyIndicators = true;
      break;
    }
  }

  return { exportedFunctions, hasPasskeyIndicators };
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a transaction's authentication profile into a wallet type.
 *
 * @param sourceAccount  The transaction source account address.
 * @param authEntries    Parsed auth entries from the transaction XDR.
 * @param functionName   The invoked contract function name (if known).
 * @param wasmIndicators Optional WASM-level indicators from extractWasmAaIndicators.
 */
export function classifyWallet(
  sourceAccount: string,
  authEntries: ParsedAuth[],
  functionName: string | null,
  wasmIndicators?: ReturnType<typeof extractWasmAaIndicators>,
): WalletClassification {
  const isContractSource = isContractAddress(sourceAccount);
  const analysis = analyzeAuthTree(authEntries);
  const detectedMethods: string[] = [];

  // ── detect individual auth methods ────────────────────────────────────────

  const exportedFns = new Set(wasmIndicators?.exportedFunctions ?? []);
  const allFunctionNames = new Set([
    ...(functionName ? [functionName] : []),
    ...analysis.hasFunctionNames,
    ...exportedFns,
  ]);

  const hasMultiSig =
    analysis.signerCount > 1 ||
    allFunctionNames.has('add_signer') ||
    allFunctionNames.has('set_threshold') ||
    allFunctionNames.has('__check_auth');

  const hasSocialRecovery =
    allFunctionNames.has('add_guardian') ||
    allFunctionNames.has('social_recover') ||
    allFunctionNames.has('initiate_recovery') ||
    allFunctionNames.has('complete_recovery');

  const hasSessionKey =
    allFunctionNames.has('add_session_key') ||
    allFunctionNames.has('authorize_session') ||
    allFunctionNames.has('revoke_session_key');

  const hasPasskey =
    (wasmIndicators?.hasPasskeyIndicators ?? false) ||
    allFunctionNames.has('verify_passkey') ||
    allFunctionNames.has('webauthn_verify') ||
    allFunctionNames.has('fido2_verify');

  if (hasMultiSig) detectedMethods.push('multi_sig');
  if (hasSocialRecovery) detectedMethods.push('social_recovery');
  if (hasSessionKey) detectedMethods.push('session_key');
  if (hasPasskey) detectedMethods.push('passkey');

  // ── determine primary wallet type ─────────────────────────────────────────

  let walletType: WalletType;
  if (!isContractSource && !analysis.hasContractAuth && detectedMethods.length === 0) {
    // Classic G-account sponsoring a contract call — classify as sponsored
    walletType = 'sponsored';
  } else if (detectedMethods.length > 1) {
    walletType = 'hybrid';
  } else if (detectedMethods.length === 1) {
    walletType = detectedMethods[0] as WalletType;
  } else if (isContractSource || analysis.hasContractAuth) {
    walletType = 'custom';
  } else {
    walletType = 'custom';
  }

  // ── extract signer / guardian / session key details ────────────────────────

  const signerCount = hasMultiSig ? analysis.signerCount : null;
  const threshold = null; // requires on-chain state query; set during enrichment

  // Auth addresses beyond the first are likely co-signers or guardians
  const extraAddresses = analysis.addresses.filter((a) => a !== sourceAccount);
  const guardians = hasSocialRecovery ? extraAddresses : [];
  const sessionKeys: SessionKeyInfo[] = hasSessionKey
    ? extraAddresses.map((a) => ({ address: a, expiryLedger: null }))
    : [];

  const isSmartWallet = isContractSource || analysis.hasContractAuth || detectedMethods.length > 0;

  return {
    walletType,
    signerCount,
    threshold,
    guardians,
    sessionKeys,
    authMethods: detectedMethods,
    isSmartWallet,
  };
}

// ── Behavioral call-pattern classifier ───────────────────────────────────────

/**
 * Snapshot of a wallet's historical call counts by function name.
 * Populated from the DB by the AA indexer after initial classification.
 */
export interface WalletBehaviorProfile {
  /** Map of functionName → call count over all observed transactions */
  callCounts: Record<string, number>;
  /** Total number of unique signers observed across all transactions */
  observedSignerCount: number;
}

/**
 * Refine or upgrade a wallet classification using behavioral signals
 * (historical call frequencies). Called after several transactions have
 * been processed so the pattern is statistically meaningful.
 *
 * Returns a new walletType if behavior strongly indicates a different class,
 * otherwise returns the existing classification unchanged.
 */
export function refineBehaviorClassification(
  current: WalletClassification,
  profile: WalletBehaviorProfile,
): WalletClassification {
  const counts = profile.callCounts;
  const totalCalls = Object.values(counts).reduce((s, n) => s + n, 0);
  if (totalCalls === 0) return current;

  const detectedMethods = new Set(current.authMethods);

  // Strong social-recovery signal: recovery-related calls ≥ 10 % of all calls
  const recoveryCount =
    (counts['social_recover'] ?? 0) +
    (counts['initiate_recovery'] ?? 0) +
    (counts['complete_recovery'] ?? 0);
  if (recoveryCount / totalCalls >= 0.1) detectedMethods.add('social_recovery');

  // Strong session-key signal: session management calls ≥ 20 %
  const sessionCount =
    (counts['add_session_key'] ?? 0) +
    (counts['authorize_session'] ?? 0) +
    (counts['revoke_session_key'] ?? 0);
  if (sessionCount / totalCalls >= 0.2) detectedMethods.add('session_key');

  // Multi-sig signal: observed > 1 unique signer across transactions
  if (profile.observedSignerCount > 1) detectedMethods.add('multi_sig');

  const methods = [...detectedMethods];
  if (
    methods.length === current.authMethods.length &&
    methods.every((m) => current.authMethods.includes(m))
  ) {
    return current; // no change
  }

  let walletType: WalletType;
  if (methods.length > 1) {
    walletType = 'hybrid';
  } else if (methods.length === 1) {
    walletType = methods[0] as WalletType;
  } else {
    walletType = current.walletType;
  }

  return { ...current, walletType, authMethods: methods };
}

// ── Session key extraction from auth entries ──────────────────────────────────

/**
 * Extract any session-key candidates directly from auth entries.
 * A session key is a *non-contract* (G-account) address appearing in auth
 * entries for a *contract-source* transaction — i.e., a hot signer
 * authorized by the smart wallet.
 */
export function extractSessionKeysFromAuth(
  sourceAccount: string,
  authEntries: ParsedAuth[],
): SessionKeyInfo[] {
  if (!isContractAddress(sourceAccount)) return [];
  return authEntries
    .filter((e) => e.type === 'account' && e.address !== sourceAccount)
    .map((e) => ({ address: e.address, expiryLedger: null }));
}

export interface AuthDecompositionRecord {
  transactionHash: string;
  walletAddress: string | null;
  authTree: ParsedAuth[];
  authMethods: string[];
  signerCount: number;
  hasSubCalls: boolean;
  humanReadable: string;
  ledgerSequence: number;
}

export function buildAuthDecomposition(
  transactionHash: string,
  sourceAccount: string,
  authEntries: ParsedAuth[],
  classification: WalletClassification,
  ledgerSequence: number,
  functionName: string | null = null,
  contractAddress: string | null = null,
): AuthDecompositionRecord {
  const hasSubCalls = authEntries.some((e) => e.subInvocations.length > 0);
  return {
    transactionHash,
    walletAddress: isContractAddress(sourceAccount) ? sourceAccount : null,
    authTree: authEntries,
    authMethods: classification.authMethods,
    signerCount: classification.signerCount ?? authEntries.length,
    hasSubCalls,
    humanReadable: renderAuthTree(authEntries, classification, functionName, contractAddress),
    ledgerSequence,
  };
}

// ── Human-readable auth tree rendering ───────────────────────────────────────

/**
 * Render a ParsedAuth[] tree into a plain-English description.
 *
 * Examples:
 *   "GABC… authorized swap on CDEF… (2 sub-calls)"
 *   "multi_sig: 3 signers (GAAA…, GBBB…, GCCC…) authorized execute on CWALLET…"
 *   "session key GKEY… authorized transfer on CTOKEN… via CWALLET…"
 */
export function renderAuthTree(
  authEntries: ParsedAuth[],
  classification: WalletClassification,
  functionName: string | null,
  contractAddress: string | null,
): string {
  if (authEntries.length === 0) {
    return functionName
      ? `Source account called ${functionName}${contractAddress ? ` on ${shorten(contractAddress)}` : ''}`
      : 'No authorization entries';
  }

  const fn = functionName ?? 'unknown function';
  const target = contractAddress ? ` on ${shorten(contractAddress)}` : '';

  if (classification.walletType === 'multi_sig' && authEntries.length > 1) {
    const signers = authEntries.map((e) => shorten(e.address)).join(', ');
    const threshold = classification.threshold
      ? `${classification.threshold}-of-${authEntries.length}`
      : `${authEntries.length}`;
    return `multi-sig (${threshold}): [${signers}] authorized ${fn}${target}`;
  }

  if (classification.walletType === 'social_recovery' && classification.guardians.length > 0) {
    const guardians = classification.guardians.map(shorten).join(', ');
    return `social recovery via guardians [${guardians}]: authorized ${fn}${target}`;
  }

  if (classification.walletType === 'session_key' && classification.sessionKeys.length > 0) {
    const key = shorten(classification.sessionKeys[0].address);
    const expiry = classification.sessionKeys[0].expiryLedger
      ? ` (expires ledger ${classification.sessionKeys[0].expiryLedger})`
      : '';
    return `session key ${key}${expiry} authorized ${fn}${target}`;
  }

  if (classification.walletType === 'passkey') {
    return `passkey/WebAuthn authorized ${fn}${target}`;
  }

  if (classification.walletType === 'sponsored') {
    return `sponsored: ${shorten(authEntries[0].address)} authorized ${fn}${target}`;
  }

  // generic: list all authorizing addresses
  const signers = authEntries.map((e) => shorten(e.address)).join(', ');
  const subCalls = authEntries.some((e) => e.subInvocations.length > 0)
    ? ` with ${authEntries.flatMap((e) => e.subInvocations).length} sub-call(s)`
    : '';
  return `${signers} authorized ${fn}${target}${subCalls}`;
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── extractAuthData ───────────────────────────────────────────────────────────

export interface ExtractedAuthData {
  signers: string[];
  contractAddresses: string[];
  functionNames: string[];
  depth: number;
  hasContractAuth: boolean;
}

/**
 * Parse a base64 XDR transaction envelope and extract all authentication data
 * (signers, contract addresses, called function names, tree depth).
 */
export function extractAuthData(rawXdr: string): ExtractedAuthData {
  const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');

  let operations: xdr.Operation[];
  if (envelope.switch().name === 'envelopeTypeTxFeeBump') {
    operations = envelope.feeBump().tx().innerTx().v1().tx().operations();
  } else if (envelope.switch().name === 'envelopeTypeTx') {
    operations = envelope.v1().tx().operations();
  } else {
    operations = (envelope as any).v0().tx().operations();
  }

  const signers = new Set<string>();
  const contractAddresses = new Set<string>();
  const functionNames = new Set<string>();
  let hasContractAuth = false;
  let maxDepth = 0;

  function walkInvocation(node: xdr.SorobanAuthorizedInvocation, depth: number): void {
    maxDepth = Math.max(maxDepth, depth);
    const fn = node.function();
    if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
      const contractFn = fn.contractFn();
      functionNames.add(contractFn.functionName().toString());
      const addr = contractFn.contractAddress();
      if (addr.switch().name === 'scAddressTypeContract') {
        contractAddresses.add(StrKey.encodeContract(addr.contractId()));
      }
    }
    for (const sub of node.subInvocations()) walkInvocation(sub, depth + 1);
  }

  for (const op of operations) {
    if (op.body().switch().name !== 'invokeHostFunction') continue;
    for (const authEntry of op.body().invokeHostFunctionOp().auth()) {
      const creds = authEntry.credentials();
      if (creds.switch().name === 'sorobanCredentialsAddress') {
        const addr = creds.address().address();
        if (addr.switch().name === 'scAddressTypeAccount') {
          signers.add(StrKey.encodeEd25519PublicKey(addr.accountId().ed25519()));
        } else if (addr.switch().name === 'scAddressTypeContract') {
          contractAddresses.add(StrKey.encodeContract(addr.contractId()));
          hasContractAuth = true;
        }
      }
      walkInvocation(authEntry.rootInvocation(), 1);
    }
  }

  return {
    signers: [...signers],
    contractAddresses: [...contractAddresses],
    functionNames: [...functionNames],
    depth: maxDepth,
    hasContractAuth,
  };
}

// ── flattenAuthTree ───────────────────────────────────────────────────────────

export interface FlatAuthNode {
  depth: number;
  contractAddress: string;
  functionName: string;
}

/**
 * Recursively flatten a ParsedAuth[] tree into an ordered list of
 * {depth, contractAddress, functionName} nodes for call-trace rendering.
 */
export function flattenAuthTree(entries: import('./xdr-parser').ParsedAuth[]): FlatAuthNode[] {
  const result: FlatAuthNode[] = [];

  function walk(subs: import('./xdr-parser').ParsedAuth['subInvocations'], depth: number): void {
    for (const sub of subs) {
      result.push({ depth, contractAddress: sub.contractId, functionName: sub.functionName });
    }
  }

  for (const entry of entries) walk(entry.subInvocations, 1);
  return result;
}
