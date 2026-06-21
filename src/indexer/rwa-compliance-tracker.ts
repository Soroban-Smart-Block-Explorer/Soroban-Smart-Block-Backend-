import { prismaWrite as prisma } from '../db';

/**
 * Track RWA clawback and compliance events.
 * Captures asset enforcement actions on regulated real-world financial tokens.
 */
export async function trackRwaClawback(
  transactionHash: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  assetContractAddress: string,
  issuerAddress: string,
  targetAddress: string,
  amount: string,
  complianceReason: string,
): Promise<void> {
  const humanStatement = `Issuer recovered ${amount} tokens from address ${targetAddress} based on ${complianceReason}`;

  await prisma.rwaComplianceEvent.upsert({
    where: { transactionHash },
    update: {},
    create: {
      transactionHash,
      ledgerSequence,
      ledgerCloseTime,
      assetContractAddress,
      issuerAddress,
      targetAddress,
      amount,
      complianceReason,
      humanStatement,
    },
  });
}

/**
 * Get compliance events for an asset.
 */
export async function getAssetComplianceEvents(assetAddress: string) {
  return prisma.rwaComplianceEvent.findMany({
    where: { assetContractAddress: assetAddress },
    orderBy: { ledgerSequence: 'desc' },
  });
}

/**
 * Get compliance events for a target address.
 */
export async function getAddressComplianceHistory(targetAddress: string) {
  return prisma.rwaComplianceEvent.findMany({
    where: { targetAddress },
    orderBy: { ledgerSequence: 'desc' },
  });
}

/**
 * Get compliance events by issuer.
 */
export async function getIssuerComplianceActions(issuerAddress: string) {
  return prisma.rwaComplianceEvent.findMany({
    where: { issuerAddress },
    orderBy: { ledgerSequence: 'desc' },
  });
}
