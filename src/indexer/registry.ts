import { xdr } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';
import { decodeTypedArgs, formatAmount } from './args-decoder';
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

/**
 * Get ABI for a contract address. Falls back to SEP-41 for token contracts.
 */
export async function getContractAbi(contractAddress: string): Promise<ContractAbi | null> {
  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  if (!contract) return null;
  if (contract.isToken) return SEP41_ABI;
  if (contract.abi) return contract.abi as unknown as ContractAbi;
  return null;
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
