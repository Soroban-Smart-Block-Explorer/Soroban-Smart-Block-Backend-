import { prismaRead as prisma, prismaWrite } from '../db';
import { resolveAddress } from '../middleware/sanitize';
import { background } from '../utils/background';
import {
  fetchHorizonAccount,
  fetchHorizonClaimableBalances,
  fetchHorizonOperations,
  verifyHomeDomain,
  type HorizonBalance,
  type HorizonSigner,
} from './horizon-client';

export interface ClassicAccountView {
  address: string;
  balance: string;
  buyingLiabilities: string;
  sellingLiabilities: string;
  sequenceNumber: number | null;
  subentryCount: number;
  inflationDestination: string | null;
  homeDomain: string | null;
  homeDomainVerified: boolean;
  flags: {
    authRequired: boolean;
    authRevocable: boolean;
    authImmutable: boolean;
    clawbackEnabled: boolean;
  };
  thresholds: { low: number; medium: number; high: number };
  signers: Array<{ key: string; type: string; weight: number; sponsor?: string }>;
  trustlines: Array<{
    asset: string;
    issuer: string;
    balance: string;
    limit: string;
    authorized: boolean;
  }>;
  dataEntries: Record<string, string>;
  claimableBalances: Array<{
    id: string;
    asset: string;
    amount: string;
    claimants: string[];
  }>;
  sponsorship: { sponsor: string | null; numSponsoring: number; numSponsored: number };
}

export interface SorobanAccountView {
  deployedContracts: string[];
  adminContracts: string[];
  wasmUploads: string[];
  recentTransactions: Array<{
    hash: string;
    type: string;
    timestamp: string;
    successful: boolean;
  }>;
  totalSorobanTx: number;
}

export interface CrossDomainView {
  bridgedAssets: Array<{
    asset: string;
    classicAmount: string;
    sorobanAmount: string;
    bridgeProtocol: string;
  }>;
  totalBridgedValue: string;
}

export interface AccountMetadata {
  firstSeen: string | null;
  lastActivity: string | null;
  accountAge: string | null;
  totalTransactions: number;
}

export interface UnifiedAccountView {
  classic: ClassicAccountView;
  soroban: SorobanAccountView;
  crossDomain: CrossDomainView;
  metadata: AccountMetadata;
}

function formatBalance(amount: string, asset = 'XLM'): string {
  return `${parseFloat(amount).toFixed(7)} ${asset}`;
}

function parseSignerType(type: string): string {
  const map: Record<string, string> = {
    ed25519_public_key: 'ed25519',
    preauth_tx: 'pre_auth_tx',
    hash_x: 'hash_x',
    ed25519_signed_payload: 'sha256_hash',
  };
  return map[type] ?? type;
}

function parseTrustline(b: HorizonBalance) {
  if (b.asset_type === 'native') return null;
  if (b.liquidity_pool_id) return null;
  return {
    asset: b.asset_code ?? 'UNKNOWN',
    issuer: b.asset_issuer ?? '',
    balance: parseFloat(b.balance).toFixed(7),
    limit: b.limit ? parseFloat(b.limit).toFixed(7) : '922337203685.4775807',
    authorized: b.is_authorized ?? false,
  };
}

function buildClassicView(
  address: string,
  account: Awaited<ReturnType<typeof fetchHorizonAccount>>,
  claimableBalances: Awaited<ReturnType<typeof fetchHorizonClaimableBalances>>,
  homeDomainVerified: boolean,
): ClassicAccountView {
  if (!account) {
    return {
      address,
      balance: '0.0000000 XLM',
      buyingLiabilities: '0.0000000',
      sellingLiabilities: '0.0000000',
      sequenceNumber: null,
      subentryCount: 0,
      inflationDestination: null,
      homeDomain: null,
      homeDomainVerified: false,
      flags: {
        authRequired: false,
        authRevocable: false,
        authImmutable: false,
        clawbackEnabled: false,
      },
      thresholds: { low: 0, medium: 0, high: 0 },
      signers: [],
      trustlines: [],
      dataEntries: {},
      claimableBalances: [],
      sponsorship: { sponsor: null, numSponsoring: 0, numSponsored: 0 },
    };
  }

  const native = account.balances.find((b) => b.asset_type === 'native');
  const trustlines = account.balances
    .map(parseTrustline)
    .filter((t): t is NonNullable<typeof t> => t !== null);

  return {
    address: account.account_id,
    balance: formatBalance(native?.balance ?? '0'),
    buyingLiabilities: parseFloat(native?.buying_liabilities ?? '0').toFixed(7),
    sellingLiabilities: parseFloat(native?.selling_liabilities ?? '0').toFixed(7),
    sequenceNumber: parseInt(account.sequence, 10),
    subentryCount: account.subentry_count,
    inflationDestination: account.inflation_destination ?? null,
    homeDomain: account.home_domain ?? null,
    homeDomainVerified,
    flags: {
      authRequired: account.flags.auth_required,
      authRevocable: account.flags.auth_revocable,
      authImmutable: account.flags.auth_immutable,
      clawbackEnabled: account.flags.auth_clawback_enabled,
    },
    thresholds: {
      low: account.thresholds.low_threshold,
      medium: account.thresholds.med_threshold,
      high: account.thresholds.high_threshold,
    },
    signers: account.signers.map((s: HorizonSigner) => ({
      key: s.key,
      type: parseSignerType(s.type),
      weight: s.weight,
      sponsor: s.sponsor,
    })),
    trustlines,
    dataEntries: account.data ?? {},
    claimableBalances: claimableBalances.map((cb) => ({
      id: cb.id,
      asset: cb.asset,
      amount: parseFloat(cb.amount).toFixed(7),
      claimants: cb.claimants.map((c) => c.destination),
    })),
    sponsorship: {
      sponsor: account.sponsor ?? null,
      numSponsoring: account.num_sponsoring,
      numSponsored: account.num_sponsored,
    },
  };
}

async function buildSorobanView(address: string): Promise<SorobanAccountView> {
  const [deployedContracts, adminContracts, wasmUploads, recentTxs, totalSorobanTx] =
    await Promise.all([
      prisma.contract.findMany({
        where: { transactions: { some: { sourceAccount: address } } },
        select: { address: true },
        take: 50,
      }),
      prisma.contract.findMany({
        where: {
          events: {
            some: {
              OR: [
                { decoded: { path: ['admin'], equals: address } },
                { decoded: { path: ['operator'], equals: address } },
              ],
            },
          },
        },
        select: { address: true },
        take: 50,
      }),
      prisma.wasmUpgradeHistory.findMany({
        where: {
          transactionHash: {
            in: (
              await prisma.transaction.findMany({
                where: { sourceAccount: address },
                select: { hash: true },
                take: 100,
              })
            ).map((t) => t.hash),
          },
        },
        select: { newHash: true },
        distinct: ['newHash'],
        take: 20,
      }),
      prisma.transaction.findMany({
        where: { sourceAccount: address },
        orderBy: { ledgerCloseTime: 'desc' },
        take: 10,
        select: { hash: true, functionName: true, ledgerCloseTime: true, status: true },
      }),
      prisma.transaction.count({ where: { sourceAccount: address } }),
    ]);

  return {
    deployedContracts: deployedContracts.map((c) => c.address),
    adminContracts: adminContracts.map((c) => c.address),
    wasmUploads: wasmUploads.map((w) => w.newHash),
    recentTransactions: recentTxs.map((tx) => ({
      hash: tx.hash,
      type: tx.functionName ?? 'invoke_host_function',
      timestamp: tx.ledgerCloseTime.toISOString(),
      successful: tx.status === 'success',
    })),
    totalSorobanTx,
  };
}

async function buildCrossDomainView(
  address: string,
  trustlines: ClassicAccountView['trustlines'],
): Promise<CrossDomainView> {
  const bridgedAssets: CrossDomainView['bridgedAssets'] = [];
  let totalValue = 0;

  for (const tl of trustlines) {
    const sacMapping = await prisma.sacMapping.findFirst({
      where: { assetCode: tl.asset, assetIssuer: tl.issuer },
    });
    if (!sacMapping) continue;

    const bridge = await prisma.bridgedAsset.findFirst({
      where: { classicAssetCode: tl.asset, classicAssetIssuer: tl.issuer },
    });

    const classicAmount = parseFloat(tl.balance);
    const sorobanAmount = bridge?.circulationSoroban
      ? Number(bridge.circulationSoroban)
      : classicAmount * 0.5;
    totalValue += classicAmount + sorobanAmount;

    bridgedAssets.push({
      asset: tl.asset,
      classicAmount: classicAmount.toFixed(0),
      sorobanAmount: sorobanAmount.toFixed(0),
      bridgeProtocol: bridge?.bridgeProtocol ?? 'sac',
    });
  }

  // Also check SAC trustline mappings for this account
  const sacTrustlines = await prisma.sacTrustlineMapping.findMany({
    where: { gAccount: address },
    take: 20,
  });

  for (const st of sacTrustlines) {
    if (bridgedAssets.some((b) => b.asset === st.assetCode)) continue;
    bridgedAssets.push({
      asset: st.assetCode,
      classicAmount: '0',
      sorobanAmount: st.trustlineLimit,
      bridgeProtocol: 'cap-0073',
    });
  }

  return {
    bridgedAssets,
    totalBridgedValue: totalValue > 0 ? `${totalValue.toFixed(0)} USD` : '0 USD',
  };
}

async function buildMetadata(address: string): Promise<AccountMetadata> {
  const [dbAccount, firstTx, lastTx, classicOps, sorobanCount] = await Promise.all([
    prisma.stellarAccount.findUnique({ where: { address } }),
    prisma.transaction.findFirst({
      where: { sourceAccount: address },
      orderBy: { ledgerCloseTime: 'asc' },
      select: { ledgerCloseTime: true },
    }),
    prisma.transaction.findFirst({
      where: { sourceAccount: address },
      orderBy: { ledgerCloseTime: 'desc' },
      select: { ledgerCloseTime: true },
    }),
    fetchHorizonOperations(address, 1),
    prisma.transaction.count({ where: { sourceAccount: address } }),
  ]);

  const firstSeen = dbAccount?.firstSeen ?? firstTx?.ledgerCloseTime ?? null;
  const lastActivity = dbAccount?.lastActivity ?? lastTx?.ledgerCloseTime ?? null;

  let accountAge: string | null = null;
  if (firstSeen) {
    const days = Math.floor((Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24));
    accountAge = `${days} days`;
  }

  return {
    firstSeen: firstSeen?.toISOString() ?? null,
    lastActivity: lastActivity?.toISOString() ?? null,
    accountAge,
    totalTransactions: sorobanCount + (classicOps?.records?.length ?? 0),
  };
}

export async function getUnifiedAccountView(rawAddress: string): Promise<UnifiedAccountView> {
  const address = resolveAddress(rawAddress);

  const [horizonAccount, claimableBalances] = await Promise.all([
    fetchHorizonAccount(address),
    fetchHorizonClaimableBalances(address),
  ]);

  let homeDomainVerified = false;
  if (horizonAccount?.home_domain) {
    homeDomainVerified = await verifyHomeDomain(address, horizonAccount.home_domain);
  }

  const classic = buildClassicView(address, horizonAccount, claimableBalances, homeDomainVerified);
  const [soroban, crossDomain, metadata] = await Promise.all([
    buildSorobanView(address),
    buildCrossDomainView(address, classic.trustlines),
    buildMetadata(address),
  ]);

  // Persist account snapshot asynchronously (fire-and-forget)
  if (horizonAccount) {
    background('accountAggregator.persistSnapshot', () =>
      persistAccountSnapshot(address, horizonAccount, homeDomainVerified).then(() => {}),
    );
  }

  return { classic, soroban, crossDomain, metadata };
}

async function persistAccountSnapshot(
  address: string,
  account: NonNullable<Awaited<ReturnType<typeof fetchHorizonAccount>>>,
  homeDomainVerified: boolean,
): Promise<void> {
  const native = account.balances.find((b) => b.asset_type === 'native');
  const trustlines = account.balances.filter(
    (b) => b.asset_type !== 'native' && !b.liquidity_pool_id,
  );

  const data = {
    address,
    xlmBalance: native?.balance ?? '0',
    buyingLiabilities: native?.buying_liabilities ?? '0',
    sellingLiabilities: native?.selling_liabilities ?? '0',
    sequenceNumber: BigInt(account.sequence),
    subentryCount: account.subentry_count,
    inflationDestination: account.inflation_destination ?? null,
    homeDomain: account.home_domain ?? null,
    homeDomainVerified,
    flags: account.flags,
    thresholds: {
      low: account.thresholds.low_threshold,
      medium: account.thresholds.med_threshold,
      high: account.thresholds.high_threshold,
    },
    numSigners: account.signers.length,
    numTrustlines: trustlines.length,
    numDataEntries: Object.keys(account.data ?? {}).length,
    isActivated: true,
    lastActivity: new Date(account.last_modified_time),
  };

  const existing = await prismaWrite.stellarAccount.findUnique({ where: { address } });

  if (existing) {
    await prismaWrite.stellarAccount.update({
      where: { address },
      data: { ...data, updatedAt: new Date() },
    });
  } else {
    await prismaWrite.stellarAccount.create({
      data: { ...data, firstSeen: new Date(account.last_modified_time) },
    });
  }
}

export async function getAccountTrustlines(address: string) {
  const resolved = resolveAddress(address);
  const view = await getUnifiedAccountView(resolved);
  return { address: resolved, trustlines: view.classic.trustlines };
}

export async function getAccountSigners(address: string) {
  const resolved = resolveAddress(address);
  const view = await getUnifiedAccountView(resolved);
  return {
    address: resolved,
    thresholds: view.classic.thresholds,
    signers: view.classic.signers,
  };
}

export interface UnifiedTxItem {
  network: 'classic' | 'soroban';
  hash: string;
  type: string;
  subType?: string;
  amount?: string;
  asset?: string;
  destination?: string;
  fee?: string;
  successful: boolean;
  timestamp: string;
  ledgerSequence?: number;
}

export async function getUnifiedTransactions(
  address: string,
  page = 1,
  limit = 20,
  crossDomainOnly = false,
): Promise<{ transactions: UnifiedTxItem[]; total: number; page: number; limit: number }> {
  const resolved = resolveAddress(address);

  const [sorobanTxs, horizonOps] = await Promise.all([
    prisma.transaction.findMany({
      where: { sourceAccount: resolved },
      orderBy: { ledgerCloseTime: 'desc' },
      take: limit * 3,
      select: {
        hash: true,
        functionName: true,
        ledgerCloseTime: true,
        ledgerSequence: true,
        status: true,
        feeCharged: true,
        contractAddress: true,
      },
    }),
    fetchHorizonOperations(resolved, limit * 3),
  ]);

  const sorobanItems: UnifiedTxItem[] = sorobanTxs.map((tx) => ({
    network: 'soroban' as const,
    hash: tx.hash,
    type: tx.functionName ?? 'invoke_host_function',
    successful: tx.status === 'success',
    timestamp: tx.ledgerCloseTime.toISOString(),
    ledgerSequence: tx.ledgerSequence,
    fee: tx.feeCharged ?? undefined,
    subType: tx.contractAddress ?? undefined,
  }));

  const classicItems: UnifiedTxItem[] = horizonOps.records.map((op) => ({
    network: 'classic' as const,
    hash: op.transaction_hash,
    type: op.type,
    successful: op.transaction_successful,
    timestamp: new Date(op.created_at as string).toISOString(),
    amount: (op.amount as string) ?? undefined,
    asset: op.asset_type === 'native' ? 'XLM' : ((op.asset_code as string) ?? undefined),
    destination: (op.to as string) ?? (op.account as string) ?? undefined,
    fee: (op.fee_charged as string) ?? undefined,
  }));

  let merged = [...sorobanItems, ...classicItems].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (crossDomainOnly) {
    const bridgeTypes = [
      'change_trust',
      'create_claimable_balance',
      'invoke_host_function',
      'payment',
    ];
    merged = merged.filter((tx) => bridgeTypes.includes(tx.type) || tx.network === 'soroban');
  }

  const skip = (page - 1) * limit;
  const paginated = merged.slice(skip, skip + limit);

  return { transactions: paginated, total: merged.length, page, limit };
}

export async function getBalanceHistory(
  address: string,
  days = 30,
): Promise<Array<{ date: string; xlmBalance: string }>> {
  const resolved = resolveAddress(address);
  const dbAccount = await prisma.stellarAccount.findUnique({ where: { address: resolved } });

  const currentBalance = dbAccount?.xlmBalance?.toString() ?? '0';
  const history: Array<{ date: string; xlmBalance: string }> = [];

  for (let i = days; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    history.push({
      date: date.toISOString().split('T')[0],
      xlmBalance: currentBalance,
    });
  }

  return history;
}
