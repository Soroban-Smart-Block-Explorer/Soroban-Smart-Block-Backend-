/**
 * Account Abstraction Indexer
 *
 * Processes transactions to detect smart wallets, decompose auth trees,
 * and record sponsored transactions. Called from ledgerProcessor after
 * a transaction is persisted.
 */

import { prismaWrite as prisma } from '../db';
import { parseInvokeHostFunction } from './xdr-parser';
import { rpc } from './rpc';
import { parseWasmSpec } from './wasm-spec';
import {
  classifyWallet,
  extractSponsorInfo,
  extractWasmAaIndicators,
  buildAuthDecomposition,
  isContractAddress,
  refineBehaviorClassification,
  extractSessionKeysFromAuth,
  type WalletBehaviorProfile,
} from './aa-classifier';
import { inspectSignature } from './signatureInspector';
import { inspectCustomAccount } from './customAccountInspector';
import { broadcastEvent } from '../ws/eventBroadcaster';

// Per-process in-memory cache: wasmHash → indicators.
// Avoids repeated RPC fetches for the same contract within a catch-up batch.
const wasmCache = new Map<
  string,
  ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null }
>();

/**
 * Fetch WASM for a contract address, extract AA indicators AND threshold.
 * Returns null if WASM is unavailable or not a valid Wasm binary.
 */
async function fetchWasmIndicators(
  contractAddress: string,
  wasmHash: string | null,
): Promise<(ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null }) | null> {
  const cacheKey = wasmHash ?? contractAddress;
  if (wasmCache.has(cacheKey)) return wasmCache.get(cacheKey)!;

  let wasm: Buffer;
  try {
    wasm = await (rpc as any).getContractWasmByContractId(contractAddress);
  } catch {
    return null;
  }

  const indicators = extractWasmAaIndicators(wasm);

  // Extract threshold from contractspecv0 spec entries.
  // A multi-sig wallet typically exports __check_auth(auth_context, args, signers: Vec<Address>, threshold: u32).
  // We read the threshold parameter default or look for it in the spec.
  let threshold: number | null = null;
  try {
    const specEntries = parseWasmSpec(wasm);
    for (const entry of specEntries) {
      if (entry.switch().name !== 'scSpecEntryFunctionV0') continue;
      const fn = entry.functionV0();
      const name = fn.name().toString();
      if (!['__check_auth', 'validate_signature'].includes(name)) continue;
      // Look for a u32 parameter named "threshold" or "min_signers"
      for (const input of fn.inputs()) {
        const paramName = input.name().toString();
        if (paramName === 'threshold' || paramName === 'min_signers') {
          // We found the threshold parameter — default value not in spec,
          // but its presence confirms multi-sig and we flag threshold as ≥1
          threshold = 1;
          break;
        }
      }
    }
  } catch {
    // spec parsing failure is non-fatal
  }

  const result = { ...indicators, threshold };
  wasmCache.set(cacheKey, result);
  // Evict oldest entries to prevent unbounded growth
  if (wasmCache.size > 500) {
    wasmCache.delete(wasmCache.keys().next().value!);
  }
  return result;
}

/**
 * Process a single transaction for AA signals.
 * Safe to call concurrently — all writes are upserts.
 */
export async function processAaTransaction(
  transactionHash: string,
  sourceAccount: string,
  rawXdr: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  feeCharged?: string,
): Promise<void> {
  // 1. Parse auth entries from XDR
  const parsed = rawXdr ? parseInvokeHostFunction(rawXdr) : null;
  const authEntries = parsed?.auth ?? [];
  const functionName = parsed?.functionName ?? null;

  // 2. Fetch WASM indicators for contract-source accounts
  let wasmResult:
    | (ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null })
    | null = null;
  if (isContractAddress(sourceAccount)) {
    const contract = await prisma.contract.findUnique({
      where: { address: sourceAccount },
      select: { wasmHash: true, functionSignatures: true },
    });
    // Try live WASM first, fall back to stored function signatures
    wasmResult = await fetchWasmIndicators(sourceAccount, contract?.wasmHash ?? null);
    if (!wasmResult && contract?.functionSignatures) {
      const fns = Object.keys(contract.functionSignatures as Record<string, unknown>);
      wasmResult = { exportedFunctions: fns, hasPasskeyIndicators: false, threshold: null };
    }
  }

  // 3. Classify the wallet
  const classification = classifyWallet(
    sourceAccount,
    authEntries,
    functionName,
    wasmResult ?? undefined,
  );

  // Apply threshold from WASM spec if available and not already set
  if (wasmResult?.threshold !== null && wasmResult?.threshold !== undefined) {
    classification.threshold = wasmResult.threshold;
  }

  // Only track smart wallets and sponsored transactions
  if (!classification.isSmartWallet) {
    const sponsorInfo = extractSponsorInfo(rawXdr);
    if (sponsorInfo.isFeeSponsored) {
      await recordSponsoredTransaction(
        transactionHash,
        sponsorInfo.sponsorAccount!,
        sponsorInfo.sourceAccount!,
        null,
        feeCharged,
        ledgerSequence,
        ledgerCloseTime,
      );
    }
    return;
  }

  const walletAddress = isContractAddress(sourceAccount) ? sourceAccount : null;

  // 4. Extract session keys directly from auth entries (hot signers authorizing on behalf of wallet)
  const authSessionKeys = extractSessionKeysFromAuth(sourceAccount, authEntries);
  if (authSessionKeys.length > 0) {
    // Merge with classifier-found session keys (dedup by address)
    const existing = new Set(classification.sessionKeys.map((s) => s.address));
    for (const sk of authSessionKeys) {
      if (!existing.has(sk.address)) classification.sessionKeys.push(sk);
    }
  }

  // 5. Enrich session key expiry from SessionAuthorization records
  if (classification.sessionKeys.length > 0) {
    const sessionAuths = await prisma.sessionAuthorization.findMany({
      where: { contractAddress: walletAddress ?? sourceAccount },
      orderBy: { expiryLedger: 'desc' },
      take: classification.sessionKeys.length * 2,
      select: { hotSigner: true, expiryLedger: true },
    });
    const expiryMap = new Map(sessionAuths.map((s) => [s.hotSigner, s.expiryLedger]));
    for (const sk of classification.sessionKeys) {
      sk.expiryLedger = expiryMap.get(sk.address) ?? null;
    }

    // Write any new session keys discovered in this transaction back to SessionAuthorization
    for (const sk of authSessionKeys) {
      await prisma.sessionAuthorization
        .upsert({
          where: { eventId: `${transactionHash}:${sk.address}` },
          update: {},
          create: {
            eventId: `${transactionHash}:${sk.address}`,
            contractAddress: walletAddress ?? sourceAccount,
            hotSigner: sk.address,
            authorizationType: 'session_key',
            startLedger: ledgerSequence,
            expiryLedger: sk.expiryLedger ?? ledgerSequence + 17280, // default ~24 h
            allocatedBlocks: 17280,
          },
        })
        .catch(() => undefined);
    }
  }

  // 6. Behavioral refinement — fetch call-count profile after ≥5 transactions
  let isNewWallet = false;
  const existingWallet = await prisma.smartWallet.findUnique({
    where: { address: walletAddress ?? sourceAccount },
    select: { txCount: true },
  });
  isNewWallet = !existingWallet;

  if (existingWallet && existingWallet.txCount >= 5 && walletAddress) {
    const callRows = await prisma.$queryRaw<{ fn: string; cnt: bigint }[]>`
      SELECT "functionName" AS fn, COUNT(*) AS cnt
      FROM "Transaction"
      WHERE "sourceAccount" = ${walletAddress}
      GROUP BY "functionName"
    `;
    const callCounts: Record<string, number> = {};
    let totalSigners = 0;
    for (const row of callRows) {
      if (row.fn) callCounts[row.fn] = Number(row.cnt);
    }
    // observedSignerCount: count distinct auth addresses across recent decompositions
    const signerRows = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(DISTINCT signer) AS cnt
      FROM "AuthDecomposition", jsonb_array_elements_text("authTree"::jsonb) AS t(signer)
      WHERE "walletAddress" = ${walletAddress}
    `.catch(() => [{ cnt: BigInt(classification.signerCount ?? 1) }]);
    totalSigners = Number(signerRows[0]?.cnt ?? classification.signerCount ?? 1);

    const profile: WalletBehaviorProfile = { callCounts, observedSignerCount: totalSigners };
    const refined = refineBehaviorClassification(classification, profile);
    classification.walletType = refined.walletType;
    classification.authMethods = refined.authMethods;
  }

  // 7. Upsert SmartWallet
  await prisma.smartWallet.upsert({
    where: { address: walletAddress ?? sourceAccount },
    update: {
      lastSeenLedger: ledgerSequence,
      txCount: { increment: 1 },
      walletType: classification.walletType,
      authMethods: classification.authMethods,
      ...(classification.signerCount !== null && { signerCount: classification.signerCount }),
      ...(classification.threshold !== null && { threshold: classification.threshold }),
      ...(classification.guardians.length > 0 && { guardians: classification.guardians }),
      ...(classification.sessionKeys.length > 0 && {
        sessionKeys: classification.sessionKeys as unknown as object[],
      }),
    },
    create: {
      address: walletAddress ?? sourceAccount,
      walletType: classification.walletType,
      signerCount: classification.signerCount ?? undefined,
      threshold: classification.threshold ?? undefined,
      guardians: classification.guardians,
      sessionKeys: classification.sessionKeys as unknown as object[],
      authMethods: classification.authMethods,
      deployedAtLedger: ledgerSequence,
      deployedByAccount: isContractAddress(sourceAccount) ? null : sourceAccount,
      wasmHash: wasmResult
        ? ((
            await prisma.contract.findUnique({
              where: { address: sourceAccount },
              select: { wasmHash: true },
            })
          )?.wasmHash ?? undefined)
        : undefined,
      firstSeenLedger: ledgerSequence,
      lastSeenLedger: ledgerSequence,
      txCount: 1,
    },
  });

  // 8. Auth decomposition
  if (authEntries.length > 0) {
    const decomp = buildAuthDecomposition(
      transactionHash,
      sourceAccount,
      authEntries,
      classification,
      ledgerSequence,
      functionName,
      parsed?.contractId ?? null,
    );
    await prisma.authDecomposition.upsert({
      where: { transactionHash },
      update: {},
      create: {
        transactionHash: decomp.transactionHash,
        walletAddress: decomp.walletAddress,
        authTree: decomp.authTree as unknown as object[],
        authMethods: decomp.authMethods,
        signerCount: decomp.signerCount,
        hasSubCalls: decomp.hasSubCalls,
        humanReadable: decomp.humanReadable,
        ledgerSequence: decomp.ledgerSequence,
      },
    });
  }

  // 9. Fee-bump sponsorship
  const sponsorInfo = extractSponsorInfo(rawXdr);
  if (sponsorInfo.isFeeSponsored) {
    await recordSponsoredTransaction(
      transactionHash,
      sponsorInfo.sponsorAccount!,
      sponsorInfo.sourceAccount!,
      walletAddress,
      feeCharged,
      ledgerSequence,
      ledgerCloseTime,
    );
    if (walletAddress) {
      await prisma.smartWallet.update({
        where: { address: walletAddress },
        data: { sponsoredTxCount: { increment: 1 } },
      });
    }
  }

  // 10. Passkey / secp256r1 signature inspection (non-blocking)
  if (classification.authMethods.includes('passkey') || classification.walletType === 'passkey') {
    void inspectSignature(transactionHash, ledgerSequence, rawXdr).catch(() => undefined);
  }

  // 11. Custom account (__check_auth) deep inspection (non-blocking)
  if (
    classification.authMethods.includes('multi_sig') ||
    classification.walletType === 'custom' ||
    classification.walletType === 'hybrid'
  ) {
    void inspectCustomAccount(transactionHash, ledgerSequence, rawXdr).catch(() => undefined);
  }

  // 12. Signer snapshot for threshold trend analysis
  if (walletAddress && classification.signerCount !== null) {
    await prisma.signerSnapshot
      .create({
        data: {
          contractAddress: walletAddress,
          signers: [
            ...classification.sessionKeys.map((s) => s.address),
            ...classification.guardians,
          ] as unknown as object[],
          highThreshold: classification.threshold ?? classification.signerCount,
          ledgerSequence,
        },
      })
      .catch(() => undefined);
  }

  // 13. Broadcast new smart wallet discovery over WebSocket
  if (isNewWallet) {
    broadcastEvent({
      id: `aa:${walletAddress ?? sourceAccount}`,
      contractAddress: walletAddress ?? sourceAccount,
      eventType: 'smart_wallet_detected',
      decoded: {
        walletType: classification.walletType,
        authMethods: classification.authMethods,
        signerCount: classification.signerCount,
        deployedAtLedger: ledgerSequence,
      },
      ledger: ledgerSequence,
      ledgerCloseTime,
      transactionHash,
    });
  }
}

async function recordSponsoredTransaction(
  transactionHash: string,
  sponsorAccount: string,
  sourceAccount: string,
  walletAddress: string | null,
  feeCharged: string | undefined,
  ledgerSequence: number,
  ledgerCloseTime: Date,
) {
  await prisma.sponsoredTransaction.upsert({
    where: { transactionHash },
    update: {},
    create: {
      transactionHash,
      sponsorAccount,
      sourceAccount,
      walletAddress,
      feeCharged,
      ledgerSequence,
      ledgerCloseTime,
    },
  });
}
