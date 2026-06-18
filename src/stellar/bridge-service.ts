import { prismaRead as prisma } from '../db';

export async function listBridgedAssets() {
  const [bridged, sacMappings] = await Promise.all([
    prisma.bridgedAsset.findMany({ where: { status: 'active' } }),
    prisma.sacMapping.findMany({ take: 100 }),
  ]);

  const bridgedAssets = bridged.map((b) => {
    const classicSupply = Number(b.totalSupplyClassic ?? 0);
    const sorobanSupply = Number(b.totalSupplySoroban ?? 0);
    const circulationClassic = Number(b.circulationClassic ?? classicSupply);
    const circulationSoroban = Number(b.circulationSoroban ?? sorobanSupply);

    return {
      classic: {
        code: b.classicAssetCode,
        issuer: b.classicAssetIssuer,
        totalSupply: classicSupply.toFixed(0),
      },
      soroban: {
        contract: b.sorobanContract,
        totalSupply: sorobanSupply.toFixed(0),
      },
      bridge: {
        protocol: b.bridgeProtocol,
        contract: b.bridgeContract,
        lockedInBridge: Number(b.lockedInBridge ?? 0).toFixed(0),
        totalBridgedVolume: Number(b.totalBridgedVolume ?? 0).toFixed(0),
        fee: b.bridgeFee ? Number(b.bridgeFee).toFixed(4) : '0',
      },
      circulation: {
        classic: circulationClassic.toFixed(0),
        soroban: circulationSoroban.toFixed(0),
        bridgedNet: (circulationSoroban - circulationClassic).toFixed(0),
      },
    };
  });

  // Include SAC mappings not yet in bridged_assets
  for (const sac of sacMappings) {
    const exists = bridged.some(
      (b) => b.classicAssetCode === sac.assetCode && b.classicAssetIssuer === (sac.assetIssuer ?? ''),
    );
    if (exists) continue;

    bridgedAssets.push({
      classic: { code: sac.assetCode, issuer: sac.assetIssuer ?? '', totalSupply: '0' },
      soroban: { contract: sac.sacAddress, totalSupply: '0' },
      bridge: {
        protocol: 'sac',
        contract: sac.sacAddress,
        lockedInBridge: '0',
        totalBridgedVolume: '0',
        fee: '0',
      },
      circulation: { classic: '0', soroban: '0', bridgedNet: '0' },
    });
  }

  const totalBridgedValue = bridgedAssets
    .reduce((sum, b) => sum + parseFloat(b.circulation.classic) + parseFloat(b.circulation.soroban), 0)
    .toFixed(0);

  return { bridgedAssets, totalBridgedValue: `${totalBridgedValue} USD` };
}

export async function getBridgeAssetDetail(assetCode: string) {
  const assets = await prisma.bridgedAsset.findMany({
    where: { classicAssetCode: assetCode },
  });

  if (assets.length === 0) {
    const sac = await prisma.sacMapping.findFirst({ where: { assetCode } });
    if (!sac) return null;
    return {
      classic: { code: sac.assetCode, issuer: sac.assetIssuer },
      soroban: { contract: sac.sacAddress },
      bridge: { protocol: 'sac' },
      volumeHistory: [],
    };
  }

  const asset = assets[0];
  const volumeHistory: Array<{ date: string; volume: string }> = [];
  for (let i = 30; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    volumeHistory.push({
      date: date.toISOString().split('T')[0],
      volume: Number(asset.totalBridgedVolume ?? 0).toFixed(0),
    });
  }

  return {
    classic: { code: asset.classicAssetCode, issuer: asset.classicAssetIssuer },
    soroban: { contract: asset.sorobanContract },
    bridge: {
      protocol: asset.bridgeProtocol,
      contract: asset.bridgeContract,
      lockedInBridge: asset.lockedInBridge?.toString() ?? '0',
      fee: asset.bridgeFee?.toString() ?? '0',
    },
    circulation: {
      classic: asset.circulationClassic?.toString() ?? '0',
      soroban: asset.circulationSoroban?.toString() ?? '0',
    },
    volumeHistory,
  };
}

export async function listBridgeProtocols() {
  const bridged = await prisma.bridgedAsset.findMany({ select: { bridgeProtocol: true, status: true } });
  const sacCount = await prisma.sacMapping.count();

  const protocols: Record<string, { count: number; status: string }> = { sac: { count: sacCount, status: 'active' } };

  for (const b of bridged) {
    if (!protocols[b.bridgeProtocol]) {
      protocols[b.bridgeProtocol] = { count: 0, status: b.status };
    }
    protocols[b.bridgeProtocol].count++;
  }

  return {
    protocols: Object.entries(protocols).map(([name, data]) => ({
      name,
      assetCount: data.count,
      status: data.status,
    })),
  };
}

export async function getBridgeVolumeHistory(days = 30) {
  const history: Array<{ date: string; volume: string; protocol: string }> = [];
  const bridged = await prisma.bridgedAsset.findMany();

  for (let i = days; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    for (const b of bridged) {
      history.push({
        date: dateStr,
        volume: Number(b.totalBridgedVolume ?? 0).toFixed(0),
        protocol: b.bridgeProtocol,
      });
    }
  }

  return { history };
}
