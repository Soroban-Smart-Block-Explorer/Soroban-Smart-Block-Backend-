import { xdr } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';
import { decodeTypedArgs } from './args-decoder';
import { renderTemplate } from './template-engine';
import { getSep41Abi } from './sep41-parser';

export interface ContractAbi {
  functions: AbiFunction[];
}

export interface AbiFunction {
  name: string;
  inputs: AbiParam[];
  humanTemplate?: string; // e.g. "{from} swapped {amount_in} {token_in} → {amount_out} {token_out}"
}

export interface AbiParam {
  name: string;
  type: string;
}

/**
 * Full SEP-41 ABI — single source of truth lives in sep41-parser.ts.
 * Covers all 14 standard functions: transfer, transfer_from, approve,
 * balance_of, allowance, decimals, name, symbol, mint, burn, burn_from,
 * clawback, set_admin, admin.
 */
export const SEP41_ABI: ContractAbi = getSep41Abi();

/** ABI for a deployment/contract pair, preferring the network-keyed ABI. */
function resolveAbi(
  networkAbi: unknown,
  contract: { isToken: boolean; abi: unknown },
): ContractAbi | null {
  if (networkAbi) return networkAbi as ContractAbi;
  if (contract.isToken) return SEP41_ABI;
  if (contract.abi) return contract.abi as ContractAbi;
  return null;
}

/** Canonical contract record plus the ABI that applies to a given network. */
export interface ContractContext {
  contract: Awaited<ReturnType<typeof prisma.contract.findUnique>>;
  abi: ContractAbi | null;
}

/**
 * Resolve the canonical contract record and network-appropriate ABI in one go.
 *
 * Stellar contract IDs are only unique within a network, so resolution tries the
 * address-keyed canonical record first (the common case, a single query) and
 * falls back to the per-network deployment table when the address is an alias
 * that only exists on that network.
 */
export async function getContractContext(
  contractAddress: string,
  network?: string,
): Promise<ContractContext> {
  if (network) {
    const contract = await prisma.contract.findUnique({
      where: { address: contractAddress },
      include: { networkDeployments: { where: { network }, take: 1 } },
    });
    if (contract) {
      const deployment = contract.networkDeployments[0];
      return { contract, abi: resolveAbi(deployment?.abi, contract) };
    }

    // Not a canonical address — it may be a network-specific alias.
    const deployment = await prisma.contractNetwork.findUnique({
      where: { address_network: { address: contractAddress, network } },
      include: { contract: true },
    });
    if (deployment) {
      return {
        contract: deployment.contract,
        abi: resolveAbi(deployment.abi, deployment.contract),
      };
    }
    return { contract: null, abi: null };
  }

  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  return { contract, abi: contract ? resolveAbi(null, contract) : null };
}

/**
 * Resolve the canonical Contract record for an address, optionally scoped to a
 * network.
 */
export async function getContractRecord(
  contractAddress: string,
  network?: string,
): Promise<Awaited<ReturnType<typeof prisma.contract.findUnique>>> {
  return (await getContractContext(contractAddress, network)).contract;
}

/**
 * Get ABI for a contract address. Falls back to SEP-41 for token contracts.
 *
 * When `network` is supplied the network-keyed ABI registered on the matching
 * ContractNetwork deployment takes precedence over the canonical record's ABI,
 * which lets the same protocol expose different ABIs per network.
 */
export async function getContractAbi(
  contractAddress: string,
  network?: string,
): Promise<ContractAbi | null> {
  return (await getContractContext(contractAddress, network)).abi;
}

/** A per-network contract deployment, excluding the (potentially large) ABI. */
export interface NetworkDeployment {
  address: string;
  network: string;
  abiVersion: string | null;
  abiHash: string | null;
  version: string | null;
  wasmHash: string | null;
  protocolKey: string | null;
  isCanonical: boolean;
  deployedAtLedger: number | null;
}

/**
 * Look up every network deployment sharing a linkage hint (`protocolKey`).
 *
 * This is how the same protocol deployed to several networks is discovered as
 * one family of contracts.
 */
export async function getProtocolDeployments(
  protocolKey: string,
): Promise<Array<NetworkDeployment & { contractAddress: string; name: string | null }>> {
  const rows = await prisma.contractNetwork.findMany({
    where: { protocolKey },
    select: {
      address: true,
      network: true,
      abiVersion: true,
      abiHash: true,
      version: true,
      wasmHash: true,
      protocolKey: true,
      isCanonical: true,
      deployedAtLedger: true,
      contract: { select: { address: true, name: true } },
    },
    orderBy: [{ isCanonical: 'desc' }, { network: 'asc' }],
  });

  return rows.map(({ contract, ...deployment }) => ({
    ...deployment,
    contractAddress: contract.address,
    name: contract.name,
  }));
}

/**
 * Decode raw XDR ScVal arguments into a named map using the ABI.
 * Values are the formatted strings from the typed decoder.
 */
export function decodeArgs(
  fnName: string,
  rawArgs: xdr.ScVal[],
  abi: ContractAbi,
  decimals?: number,
): Record<string, unknown> | null {
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn) return null;
  const typed = decodeTypedArgs(fn.inputs, rawArgs, decimals);
  // Expose { raw, formatted } per key so callers can choose
  return Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, v]));
}

/**
 * Render a human-readable string from decoded args and a template.
 * Delegates to the standalone template engine.
 */
export function renderHuman(
  fnName: string,
  args: Record<string, unknown>,
  abi: ContractAbi,
  contractName?: string | null,
  decimals?: number,
): string {
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn?.humanTemplate) return `Called ${fnName} on ${contractName ?? 'contract'}`;
  return renderTemplate(fn.humanTemplate, {
    args,
    decimals,
    contractName: contractName ?? undefined,
  });
}
