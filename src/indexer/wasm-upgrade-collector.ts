import { prismaWrite as prisma } from '../db';

/**
 * Detect and record WASM bytecode upgrades from update_current_contract_wasm operations.
 * Builds immutable history of contract version lineage.
 */
export async function collectWasmUpgrades(
  contractAddress: string,
  newWasmHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  transactionHash?: string,
): Promise<void> {
  const contract = await prisma.contract.findUnique({
    where: { address: contractAddress },
    select: { wasmHash: true },
  });

  const previousHash = contract?.wasmHash ?? null;

  // Only record if hash actually changed
  if (previousHash === newWasmHash) return;

  await prisma.wasmUpgradeHistory.create({
    data: {
      contractAddress,
      previousHash,
      newHash: newWasmHash,
      ledgerSequence,
      ledgerCloseTime,
      transactionHash,
    },
  });

  // Update contract's current WASM hash
  await prisma.contract.update({
    where: { address: contractAddress },
    data: { wasmHash: newWasmHash },
  });
}

/**
 * Retrieve version lineage for a contract showing all WASM upgrades.
 */
export async function getWasmVersionLineage(contractAddress: string) {
  const upgrades = await prisma.wasmUpgradeHistory.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'asc' },
    select: {
      previousHash: true,
      newHash: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
      transactionHash: true,
    },
  });

  return upgrades.map((u, idx) => ({
    version: idx + 1,
    from: u.previousHash ? `0x${u.previousHash.slice(0, 8)}...` : 'Initial',
    to: `0x${u.newHash.slice(0, 8)}...`,
    ledger: u.ledgerSequence,
    timestamp: u.ledgerCloseTime,
    txHash: u.transactionHash,
    humanReadable: `Upgraded from ${u.previousHash ? `Wasm Hash 0x${u.previousHash.slice(0, 8)}...` : 'Initial'} to 0x${u.newHash.slice(0, 8)}... at ledger ${u.ledgerSequence}`,
  }));
}
