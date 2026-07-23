import axios from 'axios';
import { Chain } from '../types';
import { CHAIN_PROVIDERS } from '../config';

interface TxStatusResult {
  confirmations: number;
  status: 'completed' | 'pending' | 'failed';
  blockNumber?: number;
  blockHash?: string;
  timestamp?: number;
  gasUsed?: string;
}

interface RateLimiter {
  lastRequest: number;
  minIntervalMs: number;
}

const rateLimiters = new Map<Chain, RateLimiter>();

function getRateLimiter(chain: Chain): RateLimiter {
  let limiter = rateLimiters.get(chain);
  if (!limiter) {
    const cfg = CHAIN_PROVIDERS[chain];
    limiter = {
      lastRequest: 0,
      minIntervalMs: Math.ceil(60000 / cfg.rateLimitPerMinute),
    };
    rateLimiters.set(chain, limiter);
  }
  return limiter;
}

async function rateLimitedRequest<T>(chain: Chain, fn: () => Promise<T>): Promise<T> {
  const limiter = getRateLimiter(chain);
  const now = Date.now();
  const elapsed = now - limiter.lastRequest;
  if (elapsed < limiter.minIntervalMs) {
    await new Promise((resolve) => setTimeout(resolve, limiter.minIntervalMs - elapsed));
  }
  limiter.lastRequest = Date.now();
  return fn();
}

// ── Ethereum ───────────────────────────────────────────────────────────────

async function queryEtherscan(
  module: string,
  action: string,
  params: Record<string, string>,
): Promise<any> {
  const cfg = CHAIN_PROVIDERS.ethereum;
  const query = new URLSearchParams({ module, action, ...params });
  if (cfg.apiKey) query.set('apikey', cfg.apiKey);
  const { data } = await axios.get(`${cfg.apiUrl}?${query.toString()}`, { timeout: 10000 });
  if (data.status === '0' && data.message !== 'No transactions found') {
    throw new Error(`Etherscan API error: ${data.message}`);
  }
  return data;
}

export async function getEthereumTxStatus(txHash: string): Promise<TxStatusResult> {
  return rateLimitedRequest('ethereum', async () => {
    const [txReceipt, txInfo] = await Promise.all([
      queryEtherscan('proxy', 'eth_getTransactionReceipt', { txhash: txHash }),
      queryEtherscan('proxy', 'eth_getTransactionByHash', { txhash: txHash }),
    ]);
    const receipt = txReceipt.result;
    const info = txInfo.result;
    if (!receipt || !info) {
      return { confirmations: 0, status: 'pending' };
    }
    const currentBlock = await getEthereumBlockNumber();
    const txBlock = parseInt(receipt.blockNumber, 16);
    const confirmations = currentBlock - txBlock;
    const status =
      receipt.status === '0x1' ? 'completed' : receipt.status === '0x0' ? 'failed' : 'pending';
    return {
      confirmations: Math.max(0, confirmations),
      status,
      blockNumber: txBlock,
      blockHash: receipt.blockHash,
    };
  });
}

export async function getEthereumBlockNumber(): Promise<number> {
  return rateLimitedRequest('ethereum', async () => {
    const data = await queryEtherscan('proxy', 'eth_blockNumber', {});
    return parseInt(data.result, 16);
  });
}

export async function getEthereumLogs(
  address: string,
  fromBlock: number,
  toBlock: number,
  topics?: string[],
): Promise<any[]> {
  return rateLimitedRequest('ethereum', async () => {
    const params: Record<string, string> = {
      address,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    };
    if (topics && topics.length > 0) {
      topics.forEach((t, i) => {
        params[`topic${i}`] = t;
      });
    }
    const data = await queryEtherscan('logs', 'getLogs', params);
    return data.result || [];
  });
}

// ── Solana ─────────────────────────────────────────────────────────────────

export async function getSolanaTxStatus(txHash: string): Promise<TxStatusResult> {
  return rateLimitedRequest('solana', async () => {
    const cfg = CHAIN_PROVIDERS.solana;
    const { data } = await axios.post(
      cfg.rpcUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [txHash, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
      },
      { timeout: 10000 },
    );
    if (data.error) {
      if (data.error.code === -32000) {
        return { confirmations: 0, status: 'pending' };
      }
      throw new Error(`Solana RPC error: ${data.error.message}`);
    }
    const result = data.result;
    if (!result) {
      return { confirmations: 0, status: 'pending' };
    }
    const confirmations = result.confirmations ?? 0;
    const slot = result.slot ?? 0;
    const err = result.meta?.err;
    return {
      confirmations,
      status: err ? 'failed' : confirmations > 0 ? 'completed' : 'pending',
      blockNumber: slot,
      timestamp: result.blockTime,
    };
  });
}

export async function getSolanaBlockHeight(): Promise<number> {
  return rateLimitedRequest('solana', async () => {
    const cfg = CHAIN_PROVIDERS.solana;
    const { data } = await axios.post(
      cfg.rpcUrl,
      { jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [] },
      { timeout: 10000 },
    );
    return data.result ?? 0;
  });
}

// ── Cosmos ─────────────────────────────────────────────────────────────────

export async function getCosmosTxStatus(txHash: string): Promise<TxStatusResult> {
  return rateLimitedRequest('cosmos', async () => {
    const cfg = CHAIN_PROVIDERS.cosmos;
    const { data } = await axios.get(`${cfg.apiUrl}/cosmos/tx/v1beta1/txs/${txHash}`, {
      timeout: 10000,
    });
    if (!data || data.code !== undefined) {
      return {
        confirmations: 1,
        status: data?.code === 0 ? 'completed' : 'failed',
        blockNumber: data?.tx_response?.height ? parseInt(data.tx_response.height) : undefined,
        timestamp: data?.tx_response?.timestamp
          ? new Date(data.tx_response.timestamp).getTime() / 1000
          : undefined,
      };
    }
    return { confirmations: 0, status: 'pending' };
  });
}

export async function getCosmosBlockHeight(): Promise<number> {
  return rateLimitedRequest('cosmos', async () => {
    const cfg = CHAIN_PROVIDERS.cosmos;
    const { data } = await axios.get(`${cfg.apiUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
      timeout: 10000,
    });
    return parseInt(data?.block?.header?.height ?? '0');
  });
}

// ── BSC ────────────────────────────────────────────────────────────────────

async function queryBscScan(
  module: string,
  action: string,
  params: Record<string, string>,
): Promise<any> {
  const cfg = CHAIN_PROVIDERS.bsc;
  const query = new URLSearchParams({ module, action, ...params });
  if (cfg.apiKey) query.set('apikey', cfg.apiKey);
  const { data } = await axios.get(`${cfg.apiUrl}?${query.toString()}`, { timeout: 10000 });
  if (data.status === '0' && data.message !== 'No transactions found') {
    throw new Error(`BSCScan API error: ${data.message}`);
  }
  return data;
}

export async function getBscTxStatus(txHash: string): Promise<TxStatusResult> {
  return rateLimitedRequest('bsc', async () => {
    const [txReceipt, txInfo] = await Promise.all([
      queryBscScan('proxy', 'eth_getTransactionReceipt', { txhash: txHash }),
      queryBscScan('proxy', 'eth_getTransactionByHash', { txhash: txHash }),
    ]);
    const receipt = txReceipt.result;
    const info = txInfo.result;
    if (!receipt || !info) {
      return { confirmations: 0, status: 'pending' };
    }
    const currentBlock = await getBscBlockNumber();
    const txBlock = parseInt(receipt.blockNumber, 16);
    const confirmations = currentBlock - txBlock;
    const status =
      receipt.status === '0x1' ? 'completed' : receipt.status === '0x0' ? 'failed' : 'pending';
    return {
      confirmations: Math.max(0, confirmations),
      status,
      blockNumber: txBlock,
      blockHash: receipt.blockHash,
    };
  });
}

export async function getBscBlockNumber(): Promise<number> {
  return rateLimitedRequest('bsc', async () => {
    const data = await queryBscScan('proxy', 'eth_blockNumber', {});
    return parseInt(data.result, 16);
  });
}

export async function getBscLogs(
  address: string,
  fromBlock: number,
  toBlock: number,
  topics?: string[],
): Promise<any[]> {
  return rateLimitedRequest('bsc', async () => {
    const params: Record<string, string> = {
      address,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    };
    if (topics && topics.length > 0) {
      topics.forEach((t, i) => {
        params[`topic${i}`] = t;
      });
    }
    const data = await queryBscScan('logs', 'getLogs', params);
    return data.result || [];
  });
}

// ── Generic ────────────────────────────────────────────────────────────────

export interface ChainProvider {
  getTxStatus(txHash: string): Promise<TxStatusResult>;
  getBlockNumber(): Promise<number>;
}

const providers: Partial<Record<Chain, ChainProvider>> = {
  ethereum: { getTxStatus: getEthereumTxStatus, getBlockNumber: getEthereumBlockNumber },
  solana: { getTxStatus: getSolanaTxStatus, getBlockNumber: getSolanaBlockHeight },
  cosmos: { getTxStatus: getCosmosTxStatus, getBlockNumber: getCosmosBlockHeight },
  bsc: { getTxStatus: getBscTxStatus, getBlockNumber: getBscBlockNumber },
};

export function getChainProvider(chain: Chain): ChainProvider {
  const provider = providers[chain];
  if (!provider) {
    throw new Error(`No provider configured for chain: ${chain}`);
  }
  return provider;
}

export { TxStatusResult, RateLimiter };
