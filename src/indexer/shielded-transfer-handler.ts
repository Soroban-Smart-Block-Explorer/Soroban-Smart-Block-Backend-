import { prismaWrite as prisma } from '../db';

/**
 * Privacy handler for shielded transfers through zero-knowledge privacy pools.
 * Masks granular amounts and routes confidential transfers to dedicated tracking.
 */
export async function handleShieldedTransfer(
  transactionHash: string,
  contractAddress: string,
  fromAddress: string | null,
  toAddress: string | null,
  amount: string | null,
  ledgerSequence: number,
  ledgerCloseTime: Date,
): Promise<void> {
  const isConfidential = amount === null || fromAddress === null || toAddress === null;

  await prisma.shieldedTransfer.create({
    data: {
      transactionHash,
      contractAddress,
      fromAddress: isConfidential ? null : fromAddress,
      toAddress: isConfidential ? null : toAddress,
      amount: isConfidential ? null : amount,
      isConfidential,
      ledgerSequence,
      ledgerCloseTime,
    },
  });
}

/**
 * Format shielded transfer for display.
 * Returns "Confidential Amount Transferred" for privacy-shielded transactions.
 */
export function formatShieldedTransfer(transfer: {
  fromAddress: string | null;
  toAddress: string | null;
  amount: string | null;
  isConfidential: boolean;
}): string {
  if (transfer.isConfidential) {
    return 'Confidential Amount Transferred';
  }

  const from = transfer.fromAddress?.slice(0, 8) ?? 'Unknown';
  const to = transfer.toAddress?.slice(0, 8) ?? 'Unknown';
  const amt = transfer.amount ?? '0';

  return `${from}... transferred ${amt} to ${to}...`;
}

/**
 * Retrieve shielded transfer history for a contract.
 */
export async function getShieldedTransferHistory(contractAddress: string, limit: number = 50) {
  const transfers = await prisma.shieldedTransfer.findMany({
    where: { contractAddress },
    orderBy: { ledgerSequence: 'desc' },
    take: limit,
    select: {
      id: true,
      transactionHash: true,
      fromAddress: true,
      toAddress: true,
      amount: true,
      isConfidential: true,
      ledgerSequence: true,
      ledgerCloseTime: true,
    },
  });

  return transfers.map((t) => ({
    id: t.id,
    txHash: t.transactionHash,
    humanReadable: formatShieldedTransfer(t),
    ledger: t.ledgerSequence,
    timestamp: t.ledgerCloseTime,
    isConfidential: t.isConfidential,
  }));
}
