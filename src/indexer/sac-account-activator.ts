/**
 * SAC Account Activator — Issue #168
 *
 * Inline detection filter for XLM SAC (Stellar Asset Contract) transfers.
 * When a transfer sends capital to an uninitialized ("Unfunded Key") address
 * and the amount meets the minimum 1 XLM network reserve, the destination
 * account status is updated to "Active Base Wallet Natively Initialized".
 *
 * Stellar minimum base reserve: 0.5 XLM (5_000_000 stroops) per account entry.
 * An account requires at least 1 base reserve (1 XLM = 10_000_000 stroops) to
 * be created on the network.
 *
 * Reference: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts
 */

import { prismaWrite as prisma } from '../db';
import { config } from '../config';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum transfer amount (in stroops) required to activate a new account. */
export const MIN_ACTIVATION_STROOPS = 10_000_000n; // 1 XLM

/** XLM native asset code used to identify the XLM SAC. */
export const XLM_ASSET_CODE = 'XLM';

/** Account status labels. */
export const ACCOUNT_STATUS = {
  UNFUNDED: 'Unfunded Key',
  ACTIVE: 'Active Base Wallet Natively Initialized',
} as const;

export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivationResult {
  /** The destination address evaluated. */
  destination: string;
  /** Whether the transfer amount meets the 1 XLM minimum reserve. */
  meetsReserve: boolean;
  /** Transfer amount in stroops. */
  amountStroops: bigint;
  /** Resolved account status after evaluation. */
  status: AccountStatus;
  /** True if this evaluation triggered a new activation record. */
  activated: boolean;
}

// ── Core evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate whether a SAC transfer to `destination` meets the minimum 1 XLM
 * reserve and, if so, upsert an AccountActivation record transitioning the
 * destination from "Unfunded Key" to "Active Base Wallet Natively Initialized".
 *
 * @param destination  - G-address of the transfer recipient.
 * @param amountStroops - Transfer amount in stroops (i128 raw value from SAC event).
 * @param sacAddress   - C-address of the SAC contract that emitted the transfer.
 * @param transactionHash - Hash of the originating transaction.
 * @param ledgerSequence  - Ledger sequence number.
 * @param ledgerCloseTime - Ledger close timestamp.
 */
export async function evaluateAccountActivation(
  destination: string,
  amountStroops: bigint,
  sacAddress: string,
  transactionHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<ActivationResult> {
  const meetsReserve = amountStroops >= MIN_ACTIVATION_STROOPS;

  // Only G-addresses (Ed25519 public keys) can be "activated" as base accounts.
  // Contract addresses (C...) are deployed, not funded into existence.
  const isBaseAccount = destination.startsWith('G');

  if (!meetsReserve || !isBaseAccount) {
    return {
      destination,
      meetsReserve,
      amountStroops,
      status: ACCOUNT_STATUS.UNFUNDED,
      activated: false,
    };
  }

  // Upsert the activation record — idempotent on (destination, transactionHash)
  await prisma.accountActivation.upsert({
    where: { transactionHash_destination: { transactionHash, destination } },
    update: {},
    create: {
      destination,
      sacAddress,
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      amountStroops: amountStroops.toString(),
      previousStatus: ACCOUNT_STATUS.UNFUNDED,
      newStatus: ACCOUNT_STATUS.ACTIVE,
    },
  });

  return {
    destination,
    meetsReserve: true,
    amountStroops,
    status: ACCOUNT_STATUS.ACTIVE,
    activated: true,
  };
}

/**
 * Inspect a decoded SEP-41 transfer event and trigger account activation
 * evaluation when the contract is the XLM SAC.
 *
 * @param decoded       - The `decoded` JSON field from the Event row.
 * @param sacAddress    - C-address of the SAC contract.
 * @param transactionHash
 * @param ledgerSequence
 * @param ledgerCloseTime
 * @returns ActivationResult if this was an XLM SAC transfer, null otherwise.
 */
export async function maybeActivateFromTransferEvent(
  decoded: Record<string, unknown>,
  sacAddress: string,
  transactionHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<ActivationResult | null> {
  // Only process transfer events
  if (decoded['event'] !== 'transfer') return null;

  // Resolve whether this SAC is the XLM native asset contract
  const sacMapping = await prisma.sacMapping.findUnique({
    where: { sacAddress },
    select: { assetCode: true, assetType: true },
  });

  // Must be the native XLM SAC
  if (!sacMapping || sacMapping.assetType !== 'native') return null;

  const to = decoded['to'];
  const amount = decoded['amount'];

  if (typeof to !== 'string' || !to) return null;

  // Amount may be stored as a formatted decimal string (e.g. "1.5000000") or
  // as a raw stroop integer string. Normalise to stroops (bigint).
  let amountStroops: bigint;
  try {
    amountStroops = parseAmountToStroops(amount);
  } catch {
    return null;
  }

  return evaluateAccountActivation(
    to,
    amountStroops,
    sacAddress,
    transactionHash,
    ledgerSequence,
    ledgerCloseTime,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an amount value (raw stroop bigint string or decimal XLM string) into
 * a bigint representing stroops.
 *
 * SEP-41 amounts are i128 raw values (stroops). The decoder may format them as
 * decimal strings like "10000000" or as human-readable "1.0000000 XLM".
 */
export function parseAmountToStroops(amount: unknown): bigint {
  if (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint') {
    throw new TypeError(`Unsupported amount type: ${typeof amount}`);
  }

  const raw = String(amount).trim().split(' ')[0]; // strip trailing token symbol

  // If it contains a decimal point, treat as XLM and convert to stroops
  if (raw.includes('.')) {
    const [intPart, fracPart = ''] = raw.split('.');
    const frac = fracPart.padEnd(7, '0').slice(0, 7); // 7 decimal places = stroops
    return BigInt(intPart) * 10_000_000n + BigInt(frac);
  }

  return BigInt(raw);
}
