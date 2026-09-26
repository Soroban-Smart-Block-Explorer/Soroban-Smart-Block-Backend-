/**
 * Verifiable build and bytecode provenance (VE06).
 *
 * A provenance record links a contract to its claimed source repo commit,
 * build hash and compiled artifact hash. Verification compares the attested
 * artifact hash with the on-chain wasm hash indexed for the contract.
 */
import { createHash } from 'crypto';
import { prismaRead } from '../db';

export interface ProvenanceRecord {
  contractAddress: string;
  repoUrl: string;
  commitSha: string;
  buildHash: string;
  artifactHash: string;
  toolchain: string;
  attestedBy: string;
  attestedAt: string;
  digest: string;
}

export type ProvenanceInput = Omit<ProvenanceRecord, 'attestedAt' | 'digest'>;

export interface VerificationResult {
  contractAddress: string;
  status: 'verified' | 'mismatch' | 'no_provenance' | 'no_onchain_hash';
  attestedArtifactHash: string | null;
  onChainWasmHash: string | null;
  checkedAt: string;
}

export function computeDigest(r: ProvenanceInput & { attestedAt: string }): string {
  const canonical = [
    r.contractAddress,
    r.repoUrl,
    r.commitSha,
    r.buildHash,
    r.artifactHash,
    r.toolchain,
    r.attestedBy,
    r.attestedAt,
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

const records = new Map<string, ProvenanceRecord[]>();

export function attest(input: ProvenanceInput): ProvenanceRecord {
  const attestedAt = new Date().toISOString();
  const record: ProvenanceRecord = {
    ...input,
    artifactHash: input.artifactHash.toLowerCase(),
    buildHash: input.buildHash.toLowerCase(),
    attestedAt,
    digest: '',
  };
  record.digest = computeDigest(record);
  const list = records.get(input.contractAddress) ?? [];
  list.push(record);
  records.set(input.contractAddress, list);
  return record;
}

export function getHistory(address: string): ProvenanceRecord[] {
  return [...(records.get(address) ?? [])].reverse();
}

export async function verifyProvenance(address: string): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  const latest = getHistory(address)[0];
  if (!latest) {
    return { contractAddress: address, status: 'no_provenance', attestedArtifactHash: null, onChainWasmHash: null, checkedAt };
  }
  const contract = await prismaRead.contract.findUnique({
    where: { address },
    select: { wasmHash: true },
  });
  const onChain = contract?.wasmHash?.toLowerCase() ?? null;
  if (!onChain) {
    return { contractAddress: address, status: 'no_onchain_hash', attestedArtifactHash: latest.artifactHash, onChainWasmHash: null, checkedAt };
  }
  return {
    contractAddress: address,
    status: onChain === latest.artifactHash ? 'verified' : 'mismatch',
    attestedArtifactHash: latest.artifactHash,
    onChainWasmHash: onChain,
    checkedAt,
  };
}
