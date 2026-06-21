import axios from 'axios';
import { config } from '../config';

const TIMEOUT = 10_000;

export interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  inflation_destination?: string;
  home_domain?: string;
  last_modified_ledger: number;
  last_modified_time: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    auth_clawback_enabled: boolean;
  };
  balances: HorizonBalance[];
  signers: HorizonSigner[];
  data: Record<string, string>;
  num_sponsoring: number;
  num_sponsored: number;
  sponsor?: string;
}

export interface HorizonBalance {
  balance: string;
  buying_liabilities: string;
  selling_liabilities: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  clawback_enabled?: boolean;
  liquidity_pool_id?: string;
}

export interface HorizonSigner {
  key: string;
  weight: number;
  type: string;
  sponsor?: string;
}

export interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  claimants: Array<{ destination: string; predicate: unknown }>;
}

export interface HorizonOperation {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful: boolean;
  source_account: string;
  [key: string]: unknown;
}

export interface HorizonAssetRecord {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  num_accounts: number;
  num_claimable_balances: number;
  num_liquidity_pools: number;
  num_contracts: number;
  amount: string;
  accounts: {
    authorized: number;
    authorized_to_maintain_liabilities: number;
    unauthorized: number;
  };
  claimable_balances_amount: string;
  liquidity_pools_amount: string;
  contracts_amount: string;
  balances: {
    authorized: string;
    authorized_to_maintain_liabilities: string;
    unauthorized: string;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    auth_clawback_enabled: boolean;
  };
  toml_meta?: { home_domain?: string; org_name?: string };
}

async function horizonGet<T>(path: string, params?: Record<string, unknown>): Promise<T | null> {
  try {
    const url = `${config.horizonUrl}${path}`;
    const resp = await axios.get<T>(url, { params, timeout: TIMEOUT });
    return resp.data;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw err;
  }
}

export async function fetchHorizonAccount(address: string): Promise<HorizonAccount | null> {
  return horizonGet<HorizonAccount>(`/accounts/${encodeURIComponent(address)}`);
}

export async function fetchHorizonClaimableBalances(
  address: string,
  limit = 20,
): Promise<HorizonClaimableBalance[]> {
  const data = await horizonGet<{ _embedded: { records: HorizonClaimableBalance[] } }>(
    '/claimable_balances',
    { claimant: address, limit, order: 'desc' },
  );
  return data?._embedded?.records ?? [];
}

export async function fetchHorizonOperations(
  address: string,
  limit = 50,
  cursor?: string,
): Promise<{
  records: HorizonOperation[];
  nextCursor: string | null;
}> {
  const params: Record<string, unknown> = { limit, order: 'desc' };
  if (cursor) params.cursor = cursor;

  const data = await horizonGet<{
    _embedded: { records: HorizonOperation[] };
    paging_token?: string;
  }>(`/accounts/${encodeURIComponent(address)}/operations`, params);

  const records = data?._embedded?.records ?? [];
  const lastRecord = records[records.length - 1] as { paging_token?: string } | undefined;
  const nextCursor = records.length > 0 ? (lastRecord?.paging_token ?? null) : null;
  return { records, nextCursor };
}

export async function fetchHorizonPayments(
  address: string,
  limit = 50,
): Promise<HorizonOperation[]> {
  const data = await horizonGet<{ _embedded: { records: HorizonOperation[] } }>(
    `/accounts/${encodeURIComponent(address)}/payments`,
    { limit, order: 'desc' },
  );
  return data?._embedded?.records ?? [];
}

export async function fetchHorizonAsset(
  code: string,
  issuer: string,
): Promise<HorizonAssetRecord | null> {
  const data = await horizonGet<{ _embedded: { records: HorizonAssetRecord[] } }>(`/assets`, {
    asset_code: code,
    asset_issuer: issuer,
  });
  return data?._embedded?.records?.[0] ?? null;
}

export async function fetchHorizonAssets(
  limit = 200,
  cursor?: string,
): Promise<{
  records: HorizonAssetRecord[];
  nextCursor: string | null;
}> {
  const params: Record<string, unknown> = { limit, order: 'desc' };
  if (cursor) params.cursor = cursor;

  const data = await horizonGet<{
    _embedded: { records: HorizonAssetRecord[] };
  }>('/assets', params);

  const records = data?._embedded?.records ?? [];
  const nextCursor =
    records.length > 0
      ? ((records[records.length - 1] as { paging_token?: string }).paging_token ?? null)
      : null;
  return { records, nextCursor };
}

export async function fetchHorizonOrderbook(
  sellingAssetCode: string,
  sellingAssetIssuer: string,
  buyingAssetCode: string,
  buyingAssetIssuer?: string,
): Promise<{
  bids: Array<{ price_r: { n: number; d: number }; price: string; amount: string }>;
  asks: Array<{ price_r: { n: number; d: number }; price: string; amount: string }>;
} | null> {
  const params: Record<string, string> = {
    selling_asset_type: sellingAssetCode === 'XLM' ? 'native' : 'credit_alphanum4',
    buying_asset_type: buyingAssetCode === 'XLM' ? 'native' : 'credit_alphanum4',
  };
  if (sellingAssetCode !== 'XLM') {
    params.selling_asset_code = sellingAssetCode;
    params.selling_asset_issuer = sellingAssetIssuer;
  }
  if (buyingAssetCode !== 'XLM') {
    params.buying_asset_code = buyingAssetCode;
    if (buyingAssetIssuer) params.buying_asset_issuer = buyingAssetIssuer;
  }

  return horizonGet('/order_book', params);
}

export async function fetchStellarToml(
  homeDomain: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `https://${homeDomain}/.well-known/stellar.toml`;
    const resp = await axios.get<string>(url, { timeout: TIMEOUT, responseType: 'text' });
    return parseToml(resp.data);
  } catch {
    return null;
  }
}

function parseToml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section = 'main';
  const sections: Record<string, Record<string, unknown>> = { main: result };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      sections[section] = {};
      if (section === 'DOCUMENTATION' || section === 'CURRENCIES') {
        result[section] = sections[section];
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    let value: unknown = kvMatch[2].trim().replace(/^"|"$/g, '');

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10);

    if (section === 'main') {
      result[key] = value;
    } else {
      sections[section][key] = value;
    }
  }

  return result;
}

export async function verifyHomeDomain(accountId: string, homeDomain: string): Promise<boolean> {
  const toml = await fetchStellarToml(homeDomain);
  if (!toml) return false;
  const accounts = toml.ACCOUNTS;
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((a) => a.trim())
      .includes(accountId);
  }
  return false;
}

export async function fetchHorizonNetworkStats(): Promise<{
  current_ledger: string;
  protocol_version: number;
  num_accounts: number;
  num_transactions: number;
  num_operations: number;
  base_fee_in_stroops: number;
} | null> {
  return horizonGet('/');
}
