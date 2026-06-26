import {
  Chain,
  BridgeContractConfig,
  ChainProviderConfig,
  AlertConfig,
} from './types';

export const BRIDGE_CONTRACTS: BridgeContractConfig[] = [
  // Wormhole
  {
    address: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
    chain: 'ethereum',
    protocol: 'wormhole',
    deployedAtBlock: 12257331,
    eventSignatures: ['LogMessagePublished'],
  },
  {
    address: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
    chain: 'solana',
    protocol: 'wormhole',
    deployedAtBlock: 0,
    eventSignatures: ['LogMessagePublished'],
  },
  {
    address: '0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6d7',
    chain: 'bsc',
    protocol: 'wormhole',
    deployedAtBlock: 8917823,
    eventSignatures: ['LogMessagePublished'],
  },
  // Axelar
  {
    address: '0x4F4495243837681061C4743b74B3eEdf548D56A5',
    chain: 'ethereum',
    protocol: 'axelar',
    deployedAtBlock: 12345678,
    eventSignatures: ['ContractCall', 'TokenSent'],
  },
  {
    address: '0xEAccEdF8bC91f5e96bDb4442F2B93CaADe1b08cd',
    chain: 'cosmos',
    protocol: 'axelar',
    deployedAtBlock: 0,
    eventSignatures: ['ContractCall', 'TokenSent'],
  },
  {
    address: '0x3ad2BE63E8b83a2E3F232EBbE648a20a9FcE2626',
    chain: 'bsc',
    protocol: 'axelar',
    deployedAtBlock: 9021567,
    eventSignatures: ['ContractCall', 'TokenSent'],
  },
  // Allbridge
  {
    address: '0xBb3F4bACeB72C2233dE61F4985Bc58E3b1bF3340',
    chain: 'ethereum',
    protocol: 'allbridge',
    deployedAtBlock: 12450000,
    eventSignatures: ['Transfer', 'AllbridgeTransfer'],
  },
  {
    address: '0xB4eB31F9e0BcA21B72eC46cF07c4BdF6F2F21D3A',
    chain: 'solana',
    protocol: 'allbridge',
    deployedAtBlock: 0,
    eventSignatures: ['Transfer', 'AllbridgeTransfer'],
  },
  {
    address: '0x6Ee51f4F7C1C5f8DbFfB8C0E7e7F8B0e8F8F8F8F',
    chain: 'bsc',
    protocol: 'allbridge',
    deployedAtBlock: 9000000,
    eventSignatures: ['Transfer', 'AllbridgeTransfer'],
  },
  // Stargate
  {
    address: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
    chain: 'ethereum',
    protocol: 'stargate',
    deployedAtBlock: 12800000,
    eventSignatures: ['Swap', 'SwapRemote'],
  },
  {
    address: '0x4a364f8c717cAAD9A442634F0562f4CbF8e6e3e4',
    chain: 'bsc',
    protocol: 'stargate',
    deployedAtBlock: 9100000,
    eventSignatures: ['Swap', 'SwapRemote'],
  },
  {
    address: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
    chain: 'polygon',
    protocol: 'stargate',
    deployedAtBlock: 15000000,
    eventSignatures: ['Swap', 'SwapRemote'],
  },
  {
    address: '0x12edeA9cd262006cC3C4E77c90d2CD2DD4b1eB90',
    chain: 'avalanche',
    protocol: 'stargate',
    deployedAtBlock: 5000000,
    eventSignatures: ['Swap', 'SwapRemote'],
  },
];

export const CHAIN_PROVIDERS: Record<Chain, ChainProviderConfig> = {
  ethereum: {
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    apiUrl: process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/api',
    apiKey: process.env.ETHERSCAN_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 12,
    blockTimeSeconds: 12,
  },
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    apiUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    apiKey: process.env.SOLANA_API_KEY,
    rateLimitPerMinute: 40,
    confirmationBlocks: 32,
    blockTimeSeconds: 0.4,
  },
  cosmos: {
    rpcUrl: process.env.COSMOS_LCD_URL || 'https://rest.cosmos.directory/cosmoshub',
    apiUrl: process.env.COSMOS_LCD_URL || 'https://rest.cosmos.directory/cosmoshub',
    apiKey: process.env.COSMOS_API_KEY,
    rateLimitPerMinute: 20,
    confirmationBlocks: 1,
    blockTimeSeconds: 6,
  },
  bsc: {
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    apiUrl: process.env.BSCSCAN_API_URL || 'https://api.bscscan.com/api',
    apiKey: process.env.BSCSCAN_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 15,
    blockTimeSeconds: 3,
  },
  polygon: {
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    apiUrl: process.env.POLYGONSCAN_API_URL || 'https://api.polygonscan.com/api',
    apiKey: process.env.POLYGONSCAN_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 128,
    blockTimeSeconds: 2,
  },
  avalanche: {
    rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    apiUrl: process.env.SNOWTRACE_API_URL || 'https://api.snowtrace.io/api',
    apiKey: process.env.SNOWTRACE_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 6,
    blockTimeSeconds: 2,
  },
  arbitrum: {
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    apiUrl: process.env.ARBISCAN_API_URL || 'https://api.arbiscan.io/api',
    apiKey: process.env.ARBISCAN_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 12,
    blockTimeSeconds: 0.25,
  },
  optimism: {
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    apiUrl: process.env.OPTIMISTIC_ETHERSCAN_API_URL || 'https://api-optimistic.etherscan.io/api',
    apiKey: process.env.OPTIMISTIC_ETHERSCAN_API_KEY,
    rateLimitPerMinute: 5,
    confirmationBlocks: 12,
    blockTimeSeconds: 2,
  },
};

export const BRIDGE_SCANNER_URLS: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  solana: 'https://solscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
};

export const ALERT_CONFIG: AlertConfig = {
  largeTransferThresholdUsd: 100000,
  maxDelayMinutes: 30,
  pollIntervalMs: parseInt(process.env.BRIDGE_POLL_INTERVAL_MS ?? '15000'),
  monitorAddresses: true,
  monitorDelays: true,
  monitorLargeTransfers: true,
};

export const VOLUME_DECIMALS = 7;
