import { prismaWrite as prisma, prismaRead } from '../db';

/**
 * Track parent-child contract relationships from factory deployments.
 * Identifies child contract addresses spawned by central factory architectures.
 */
export async function trackContractDeployment(
  parentContractAddress: string,
  childContractAddress: string,
  creationTransactionHash: string,
  creationLedgerSequence: number,
  creationTimestamp: Date,
): Promise<void> {
  await prisma.contractFactory.upsert({
    where: {
      parentContractAddress_childContractAddress: {
        parentContractAddress,
        childContractAddress,
      },
    },
    update: {},
    create: {
      parentContractAddress,
      childContractAddress,
      creationTransactionHash,
      creationLedgerSequence,
      creationTimestamp,
    },
  });
}

/**
 * Get all child contracts deployed by a factory.
 */
export async function getFactoryChildren(parentContractAddress: string) {
  return prismaRead.contractFactory.findMany({
    where: { parentContractAddress },
    orderBy: { creationLedgerSequence: 'desc' },
  });
}

/**
 * Get factory tree: parent and all descendants with metadata.
 */
export async function getFactoryTree(parentContractAddress: string) {
  const children = await prismaRead.contractFactory.findMany({
    where: { parentContractAddress },
    orderBy: { creationLedgerSequence: 'desc' },
  });

  const parent = await prismaRead.contract.findUnique({
    where: { address: parentContractAddress },
    select: { address: true, name: true, isToken: true },
  });

  const childDetails = await Promise.all(
    children.map(async (child: { childContractAddress: string }) => {
      const contract = await prismaRead.contract.findUnique({
        where: { address: child.childContractAddress },
        select: { address: true, name: true, isToken: true },
      });
      return { ...child, contractMetadata: contract };
    }),
  );

  return {
    parent,
    childCount: children.length,
    children: childDetails,
  };
}

/**
 * Get all active trading instances deployed by a DEX factory.
 */
export async function getDexInstances(factoryAddress: string) {
  return prismaRead.contractFactory.findMany({
    where: { parentContractAddress: factoryAddress },
    orderBy: { creationLedgerSequence: 'desc' },
  });
}
