/* eslint-disable @typescript-eslint/no-explicit-any */

import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { prismaWrite as prisma } from '../db';

export type PrivacyProtocol =
  | 'SHIELDED_TRANSFER'
  | 'ZK_SNARK'
  | 'ZK_STARK'
  | 'BULLETPROOF'
  | 'STEALTH_ADDRESS'
  | 'MIXER'
  | 'PRIVATE_VOTING'
  | 'OFF_CHAIN_DATA'
  | 'ENCRYPTED_STATE'
  | 'DIFFERENTIAL_PRIVACY';

export type PrivacyGuarantee =
  | 'SENDER_PRIVACY'
  | 'RECIPIENT_PRIVACY'
  | 'AMOUNT_PRIVACY'
  | 'ASSET_TYPE_PRIVACY'
  | 'VOTE_PRIVACY'
  | 'FULL_PRIVACY';

export interface DetectionResult {
  protocols: PrivacyProtocol[];
  guarantees: PrivacyGuarantee[];
  cryptographicPrimitives: Record<string, unknown>;
  anonymitySetSize: number | null;
  participants: string[];
  totalValue: string | null;
  assetType: string | null;
  contractAddresses: string[];
  confidence: number;
}

const ZK_SNARK_KEYWORDS = [
  'verify_proof',
  'verify_snark',
  'verify_groth16',
  'verify_plonk',
  'groth16_verify',
  'plonk_verify',
  'snark_verify',
  'zk_verify',
  'verify_zkp',
  'verify_shielded',
  'prove',
  'verify',
];

const ZK_STARK_KEYWORDS = [
  'verify_stark',
  'stark_verify',
  'stark_proof',
  'verify_air',
  'verify_fri',
  'verify_stark_proof',
];

const BULLETPROOF_KEYWORDS = [
  'bulletproof',
  'range_proof',
  'verify_range',
  'membership_proof',
  'verify_membership',
  'verify_bulletproof',
  'range_proof_verify',
];

const STEALTH_ADDRESS_KEYWORDS = [
  'stealth_address',
  'ephemeral_key',
  'stealth_meta',
  'generate_stealth',
  'stealth_transfer',
  'private_transfer',
  'blinded_key',
  'stealth_key',
  'meta_address',
  'one_time_address',
];

const MIXER_KEYWORDS = [
  'mixer',
  'tornado',
  'coinjoin',
  'anonymity_pool',
  'privacy_pool',
  'mix',
  'shuffle',
  'anonymize',
  'deposit_anonymized',
  'withdraw_anonymized',
  'pool_join',
  'pool_exit',
];

const PRIVATE_VOTING_KEYWORDS = [
  'private_vote',
  'encrypted_vote',
  'commitment_vote',
  'reveal_vote',
  'quadratic_vote',
  'zk_vote',
  'blind_vote',
  'vote_private',
  'commit_vote',
  'reveal_commitment',
];

const OFF_CHAIN_KEYWORDS = [
  'offchain_data',
  'data_availability',
  'off_chain_proof',
  'data_feed',
  'private_feed',
  'oracle_proof',
  'offchain_proof',
];

const ENCRYPTED_STATE_KEYWORDS = [
  'encrypted_state',
  'encrypted_storage',
  'sealed_data',
  'private_state',
  'confidential_state',
  'encrypted_balance',
  'secret_store',
];

const DIFFERENTIAL_PRIVACY_KEYWORDS = [
  'differential_privacy',
  'dp_aggregator',
  'noise_add',
  'private_aggregate',
  'dp_query',
  'epsilon_delta',
  'laplace_noise',
  'gaussian_noise',
];

function matchKeywords(functionName: string, keywords: string[]): boolean {
  if (!functionName) return false;
  const fn = functionName.toLowerCase();
  return keywords.some((k) => fn.includes(k.toLowerCase()));
}

function estimateAnonymitySet(functionName: string, args: xdr.ScVal[]): number | null {
  if (!args || args.length === 0) return null;
  try {
    const native = scValToNative(args[0]);
    if (typeof native === 'number') return Math.max(1, native);
    if (typeof native === 'string') {
      const n = parseInt(native, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    if (typeof native === 'object' && native !== null) {
      if ('anonymitySet' in native) return Number(native.anonymitySet) || null;
      if ('poolSize' in native) return Number(native.poolSize) || null;
      if ('setSize' in native) return Number(native.setSize) || null;
      if ('participants' in native && Array.isArray(native.participants))
        return native.participants.length;
    }
  } catch {
    return null;
  }
  return null;
}

function extractValue(args: xdr.ScVal[]): string | null {
  try {
    for (const arg of args) {
      const native = scValToNative(arg);
      if (typeof native === 'object' && native !== null) {
        if ('amount' in native) return String(native.amount);
        if ('value' in native) return String(native.value);
        if ('totalValue' in native) return String(native.totalValue);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractAssetType(args: xdr.ScVal[]): string | null {
  try {
    for (const arg of args) {
      const native = scValToNative(arg);
      if (typeof native === 'object' && native !== null) {
        if ('asset' in native && typeof native.asset === 'string') return native.asset;
        if ('token' in native && typeof native.token === 'string') return native.token;
        if ('assetType' in native && typeof native.assetType === 'string') return native.assetType;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function detectPrivacyTechniques(
  functionName: string | null,
  functionArgs: xdr.ScVal[],
): DetectionResult {
  const protocols: Set<PrivacyProtocol> = new Set();
  const guarantees: Set<PrivacyGuarantee> = new Set();
  const cryptoPrimitives: Record<string, unknown> = {};
  const participants: string[] = [];
  const contractAddresses: string[] = [];

  if (!functionName) {
    return {
      protocols: [],
      guarantees: [],
      cryptographicPrimitives: {},
      anonymitySetSize: null,
      participants: [],
      totalValue: null,
      assetType: null,
      contractAddresses: [],
      confidence: 0,
    };
  }

  const fn = functionName.toLowerCase();
  const args = functionArgs || [];

  let isStealth = false;

  if (matchKeywords(functionName, ZK_SNARK_KEYWORDS)) {
    protocols.add('ZK_SNARK');
    cryptoPrimitives['zkSnark'] = true;
    if (fn.includes('groth16')) cryptoPrimitives['scheme'] = 'Groth16';
    else if (fn.includes('plonk')) cryptoPrimitives['scheme'] = 'PLONK';
    else cryptoPrimitives['scheme'] = 'generic_snark';
    guarantees.add('FULL_PRIVACY');
  }

  if (matchKeywords(functionName, ZK_STARK_KEYWORDS)) {
    protocols.add('ZK_STARK');
    cryptoPrimitives['zkStark'] = true;
    guarantees.add('FULL_PRIVACY');
  }

  if (matchKeywords(functionName, BULLETPROOF_KEYWORDS)) {
    protocols.add('BULLETPROOF');
    cryptoPrimitives['bulletproof'] = true;
    if (fn.includes('range')) {
      cryptoPrimitives['proofType'] = 'range_proof';
      guarantees.add('AMOUNT_PRIVACY');
    } else if (fn.includes('membership')) {
      cryptoPrimitives['proofType'] = 'membership_proof';
      guarantees.add('SENDER_PRIVACY');
    }
  }

  if (matchKeywords(functionName, STEALTH_ADDRESS_KEYWORDS)) {
    protocols.add('STEALTH_ADDRESS');
    isStealth = true;
    cryptoPrimitives['stealthAddress'] = true;
    guarantees.add('RECIPIENT_PRIVACY');
    try {
      for (const arg of args) {
        const native = scValToNative(arg);
        if (typeof native === 'object' && native !== null) {
          if ('ephemeralKey' in native)
            cryptoPrimitives['ephemeralKey'] = String(native.ephemeralKey);
          if ('stealthAddress' in native)
            cryptoPrimitives['stealthAddress'] = String(native.stealthAddress);
          if ('viewKey' in native) cryptoPrimitives['viewKey'] = true;
        }
      }
    } catch {
      // args may not be parseable
    }
  }

  if (matchKeywords(functionName, MIXER_KEYWORDS)) {
    protocols.add('MIXER');
    cryptoPrimitives['mixer'] = true;
    if (fn.includes('deposit')) {
      cryptoPrimitives['mixerAction'] = 'deposit';
      guarantees.add('SENDER_PRIVACY');
    } else if (fn.includes('withdraw')) {
      cryptoPrimitives['mixerAction'] = 'withdraw';
      guarantees.add('RECIPIENT_PRIVACY');
    } else {
      cryptoPrimitives['mixerAction'] = 'interaction';
      guarantees.add('FULL_PRIVACY');
    }
  }

  if (matchKeywords(functionName, PRIVATE_VOTING_KEYWORDS)) {
    protocols.add('PRIVATE_VOTING');
    cryptoPrimitives['privateVoting'] = true;
    if (fn.includes('commit')) {
      cryptoPrimitives['votingPhase'] = 'commit';
      guarantees.add('VOTE_PRIVACY');
    } else if (fn.includes('reveal')) {
      cryptoPrimitives['votingPhase'] = 'reveal';
    } else {
      guarantees.add('VOTE_PRIVACY');
    }
  }

  if (matchKeywords(functionName, OFF_CHAIN_KEYWORDS)) {
    protocols.add('OFF_CHAIN_DATA');
    cryptoPrimitives['offChainData'] = true;
    if (fn.includes('feed')) cryptoPrimitives['dataType'] = 'data_feed';
    else if (fn.includes('proof')) cryptoPrimitives['dataType'] = 'off_chain_proof';
    else cryptoPrimitives['dataType'] = 'data_availability';
  }

  if (matchKeywords(functionName, ENCRYPTED_STATE_KEYWORDS)) {
    protocols.add('ENCRYPTED_STATE');
    cryptoPrimitives['encryptedState'] = true;
    cryptoPrimitives['encryption'] = 'onchain_encrypted';
    guarantees.add('AMOUNT_PRIVACY');
  }

  if (matchKeywords(functionName, DIFFERENTIAL_PRIVACY_KEYWORDS)) {
    protocols.add('DIFFERENTIAL_PRIVACY');
    cryptoPrimitives['differentialPrivacy'] = true;
    if (fn.includes('noise')) cryptoPrimitives['noiseMechanism'] = 'laplace';
    else cryptoPrimitives['noiseMechanism'] = 'gaussian';
  }

  if (matchKeywords(functionName, ['shielded', 'confidential', 'private', 'anonymou'])) {
    protocols.add('SHIELDED_TRANSFER');
    cryptoPrimitives['shieldedTransfer'] = true;
    cryptoPrimitives['commitmentHash'] = true;
    guarantees.add('AMOUNT_PRIVACY');
    if (!isStealth) guarantees.add('RECIPIENT_PRIVACY');
  }

  const anonymitySetSize = estimateAnonymitySet(functionName, args);
  const totalValue = extractValue(args);
  const assetType = extractAssetType(args);

  try {
    for (const arg of args) {
      const native = scValToNative(arg);
      if (typeof native === 'object' && native !== null) {
        if ('participants' in native && Array.isArray(native.participants)) {
          for (const p of native.participants) {
            if (typeof p === 'string') participants.push(p);
          }
        }
        if ('sender' in native && typeof native.sender === 'string')
          participants.push(native.sender);
        if ('receiver' in native && typeof native.receiver === 'string')
          participants.push(native.receiver);
        if ('from' in native && typeof native.from === 'string') participants.push(native.from);
        if ('to' in native && typeof native.to === 'string') participants.push(native.to);
      }
    }
  } catch {
    // args may not be parseable
  }

  return {
    protocols: Array.from(protocols),
    guarantees: Array.from(guarantees),
    cryptographicPrimitives: cryptoPrimitives,
    anonymitySetSize,
    participants: [...new Set(participants)],
    totalValue,
    assetType,
    contractAddresses,
    confidence: protocols.size > 0 ? Math.min(1, protocols.size * 0.25 + 0.3) : 0,
  };
}

export async function processPrivacyDetection(
  txHash: string,
  functionName: string | null,
  functionArgs: xdr.ScVal[],
  sourceAccount: string,
  ledgerSequence: number,
  timestamp: Date,
  contractAddress: string | null,
  totalTxValue?: string | null,
): Promise<DetectionResult | null> {
  const result = detectPrivacyTechniques(functionName, functionArgs);

  if (result.protocols.length === 0) return null;

  const addresses = [...new Set([sourceAccount, ...result.participants])];

  const cryptoPrimitives = result.cryptographicPrimitives as any;

  await prisma.privacyTransaction.upsert({
    where: { txHash },
    update: {
      protocols: result.protocols as any,
      guarantees: result.guarantees as any,
      cryptographicPrimitives: cryptoPrimitives,
      anonymitySetSize: result.anonymitySetSize,
      totalValue: result.totalValue || totalTxValue,
      assetType: result.assetType,
      contractAddresses: contractAddress ? [contractAddress] : [],
      participants: addresses,
      participantCount: addresses.length,
      ledgerSequence,
      timestamp,
    },
    create: {
      txHash,
      protocols: result.protocols as any,
      guarantees: result.guarantees as any,
      cryptographicPrimitives: cryptoPrimitives,
      anonymitySetSize: result.anonymitySetSize,
      totalValue: result.totalValue || totalTxValue,
      assetType: result.assetType,
      contractAddresses: contractAddress ? [contractAddress] : [],
      participants: addresses,
      participantCount: addresses.length,
      ledgerSequence,
      timestamp,
    },
  });

  return result;
}
