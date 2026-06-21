/**
 * Token Detection Pipeline — Issue #335
 *
 * Monitors Soroban for new contract deployments, detects SEP-41 and non-standard
 * tokens, extracts metadata, and performs scam/duplicate detection.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TransactionBuilder, Account: SdkAccount, Operation, BASE_FEE } = require('@stellar/stellar-sdk');

import { prismaWrite as prisma } from '../db';
import { prismaRead } from '../db';
import { config } from '../config';
import { rpc } from '../indexer/rpc';
import { logger } from '../logger';
import { Address, xdr, scValToNative } from '@stellar/stellar-sdk';

export interface DetectedTokenInput {
  contractAddress: string;
  deployerAddress: string;
  deployTxHash: string;
  deployBlock: number;
  detectedAt: Date;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  tokenStandard: 'sep41' | 'custom';
}

const KNOWN_SEP41_FUNCTIONS = new Set([
  'name', 'symbol', 'decimals', 'balance', 'total_supply',
  'transfer', 'approve', 'transfer_from', 'allowance',
  'mint', 'burn', 'set_admin', 'decimals',
]);

/**
 * Check if a contract follows SEP-41 token standard by probing for required functions.
 */
export async function detectTokenStandard(contractAddress: string): Promise<TokenMetadata | null> {
  try {
    // Probe for SEP-41 functions
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      probeContractFunction(contractAddress, 'symbol'),
      probeContractFunction(contractAddress, 'name'),
      probeContractFunction(contractAddress, 'decimals'),
      probeContractFunction(contractAddress, 'total_supply'),
    ]);

    if (symbol !== null && decimals !== null) {
      return {
        name: name !== null ? String(name) : undefined,
        symbol: String(symbol),
        decimals: Number(decimals),
        totalSupply: totalSupply !== null ? String(totalSupply) : undefined,
        tokenStandard: 'sep41',
      };
    }

    return null;
  } catch (err) {
    logger.warn('Token standard detection failed', {
      contract: contractAddress,
      error: String(err),
    });
    return null;
  }
}

/**
 * Probe a contract function via RPC simulation.
 */
async function probeContractFunction(
  contractAddress: string,
  functionName: string,
): Promise<string | null> {
  try {
    const addr = new Address(contractAddress);
    const invokeHostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: addr.toScAddress() as any,
        functionName,
        args: [],
      }),
    );

    const DUMMY_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    const txAccount = new SdkAccount(DUMMY_SOURCE, '0');
    const simulateTx = new TransactionBuilder(txAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: invokeHostFn, auth: [] }))
      .setTimeout(30)
      .build();

    const result = await rpc.simulateTransaction(simulateTx);

    if (result.error) return null;

    const retVal = (result as any).result?.retval as xdr.ScVal | undefined;
    if (!retVal) return null;

    return String(scValToNative(retVal));
  } catch {
    return null;
  }
}

/**
 * Detect token duplication/scam by comparing contract code hashes.
 */
export async function detectDuplicateTokens(
  contractCodeHash: string,
): Promise<{ isDuplicate: boolean; similarTokens: string[] }> {
  if (!contractCodeHash) return { isDuplicate: false, similarTokens: [] };

  const similar = await prismaRead.detectedToken.findMany({
    where: {
      contractCodeHash,
      status: { not: 'blacklisted' },
    },
    select: { contractAddress: true },
    take: 10,
  });

  return {
    isDuplicate: similar.length > 0,
    similarTokens: similar.map((t) => t.contractAddress),
  };
}

/**
 * Process a newly detected token: extract metadata, check for duplicates,
 * compute initial holder count, and persist to database.
 */
export async function processDetectedToken(input: DetectedTokenInput): Promise<void> {
  const existing = await prismaRead.detectedToken.findUnique({
    where: { contractAddress: input.contractAddress },
  });
  if (existing) return; // already processed

  const metadata = await detectTokenStandard(input.contractAddress);

  // Compute a simple code hash from the contract
  let codeHash: string | undefined;
  try {
    const contract = await prismaRead.contract.findUnique({
      where: { address: input.contractAddress },
      select: { wasmHash: true },
    });
    codeHash = contract?.wasmHash ?? undefined;
  } catch {
    // ignore
  }

  const duplicateInfo = codeHash
    ? await detectDuplicateTokens(codeHash)
    : { isDuplicate: false, similarTokens: [] };

  await prisma.detectedToken.create({
    data: {
      contractAddress: input.contractAddress,
      deployerAddress: input.deployerAddress,
      deployTxHash: input.deployTxHash,
      deployBlock: BigInt(input.deployBlock),
      detectedAt: input.detectedAt,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      decimals: metadata?.decimals ?? null,
      totalSupply: metadata?.totalSupply ? BigInt(metadata.totalSupply) : null,
      tokenStandard: metadata?.tokenStandard ?? 'custom',
      contractCodeHash: codeHash ?? null,
      isVerified: duplicateInfo.isDuplicate,
      verificationData: duplicateInfo.isDuplicate
        ? { similarTokens: duplicateInfo.similarTokens, flag: 'potential_scam_duplicate' }
        : undefined,
      initialHolderCount: 0,
      status: duplicateInfo.isDuplicate ? 'flagged' : 'active',
    },
  });

  // Create initial contract analysis record
  if (metadata) {
    const token = await prismaRead.detectedToken.findUnique({
      where: { contractAddress: input.contractAddress },
      select: { id: true },
    });
    if (token) {
      await prisma.tokenContractAnalysis.create({
        data: {
          tokenId: token.id,
          analysisType: 'security',
          riskScore: duplicateInfo.isDuplicate ? BigInt(8000) : BigInt(0),
          findings: duplicateInfo.isDuplicate
            ? { duplicate: true, similarContracts: duplicateInfo.similarTokens }
            : { standard: metadata.tokenStandard },
        },
      });
    }
  }

  logger.info('New token detected', {
    contract: input.contractAddress,
    symbol: metadata?.symbol,
    standard: metadata?.tokenStandard,
    isDuplicate: duplicateInfo.isDuplicate,
  });
}

/**
 * Fetch initial holders for a token by analyzing transfer events.
 */
export async function fetchInitialHolders(
  contractAddress: string,
  fromBlock: number,
): Promise<{ holders: Array<{ address: string; balance: string }>; count: number }> {
  try {
    const events = await prismaRead.event.findMany({
      where: {
        contractAddress,
        eventType: 'transfer',
        ledgerSequence: { gte: fromBlock },
      },
      select: { decoded: true },
      orderBy: { ledgerSequence: 'asc' },
      take: 1000,
    });

    const holderMap = new Map<string, bigint>();

    for (const event of events) {
      const decoded = event.decoded as Record<string, unknown> | null;
      if (!decoded) continue;

      const from = decoded.from ?? decoded.fromAddress;
      const to = decoded.to ?? decoded.toAddress ?? decoded.destination;
      const amount = decoded.amount ?? decoded.value;

      if (to && amount) {
        const current = holderMap.get(String(to)) ?? 0n;
        holderMap.set(String(to), current + BigInt(String(amount)));
      }
      if (from && amount) {
        const current = holderMap.get(String(from)) ?? 0n;
        const newBalance = current - BigInt(String(amount));
        if (newBalance <= 0n) {
          holderMap.delete(String(from));
        } else {
          holderMap.set(String(from), newBalance);
        }
      }
    }

    const holders = Array.from(holderMap.entries()).map(([address, balance]) => ({
      address,
      balance: balance.toString(),
    }));

    return { holders, count: holders.length };
  } catch (err) {
    logger.warn('Failed to fetch initial holders', {
      contract: contractAddress,
      error: String(err),
    });
    return { holders: [], count: 0 };
  }
}
