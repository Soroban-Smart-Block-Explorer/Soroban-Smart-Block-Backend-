interface AddressCluster {
  clusterId: string;
  addresses: string[];
  entityName?: string;
  entityType: string;
  riskLevel: string;
  memberCount: number;
  created_at: string;
}

const KNOWN_CLUSTERS: AddressCluster[] = [
  {
    clusterId: 'cl_exchange_1',
    addresses: ['GA5XGJ7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7Y7'],
    entityName: 'StellarX Exchange',
    entityType: 'exchange',
    riskLevel: 'low',
    memberCount: 1,
    created_at: '2024-01-01T00:00:00Z',
  },
];

export async function getCluster(address: string): Promise<{
  address: string;
  cluster: AddressCluster | null;
  clusterSize: number;
  allAddresses: string[];
}> {
  const cluster = KNOWN_CLUSTERS.find(
    c => c.addresses.some(a => a.toLowerCase() === address.toLowerCase()),
  ) ?? null;

  return {
    address,
    cluster,
    clusterSize: cluster?.addresses.length ?? 0,
    allAddresses: cluster?.addresses ?? [address],
  };
}

export async function getHighRiskClusters(
  limit: number = 20,
  offset: number = 0,
): Promise<{ clusters: AddressCluster[]; total: number }> {
  const highRisk = KNOWN_CLUSTERS.filter(
    c => c.riskLevel === 'high' || c.riskLevel === 'critical',
  );

  return {
    clusters: highRisk.slice(offset, offset + limit),
    total: highRisk.length,
  };
}

export async function createCluster(data: {
  addresses: string[];
  entityName?: string;
  entityType: string;
  riskLevel?: string;
}): Promise<AddressCluster> {
  const cluster: AddressCluster = {
    clusterId: `cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    addresses: data.addresses,
    entityName: data.entityName,
    entityType: data.entityType,
    riskLevel: data.riskLevel ?? 'medium',
    memberCount: data.addresses.length,
    created_at: new Date().toISOString(),
  };
  KNOWN_CLUSTERS.push(cluster);
  return cluster;
}
