import { describe, it, expect, vi, beforeEach } from 'vitest';

const { contractFindUnique, contractNetworkFindUnique, contractNetworkFindMany } = vi.hoisted(
  () => ({
    contractFindUnique: vi.fn(),
    contractNetworkFindUnique: vi.fn(),
    contractNetworkFindMany: vi.fn(),
  }),
);

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: contractFindUnique },
    contractNetwork: {
      findUnique: contractNetworkFindUnique,
      findMany: contractNetworkFindMany,
    },
  },
}));

import {
  getContractAbi,
  getContractRecord,
  getProtocolDeployments,
  SEP41_ABI,
} from '../../src/indexer/registry';

const NETWORK_ABI = {
  functions: [{ name: 'swap', inputs: [{ name: 'amount', type: 'i128' }] }],
};
const ALIAS_ABI = { functions: [{ name: 'bridge', inputs: [] }] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getContractAbi (network-aware)', () => {
  it('prefers the network-keyed ABI attached to the canonical contract', async () => {
    contractFindUnique.mockResolvedValue({
      isToken: false,
      abi: { functions: [] },
      networkDeployments: [{ abi: NETWORK_ABI }],
    });

    const abi = await getContractAbi('CTEST', 'mainnet');

    expect(contractFindUnique).toHaveBeenCalledWith({
      where: { address: 'CTEST' },
      include: { networkDeployments: { where: { network: 'mainnet' }, take: 1 } },
    });
    expect(abi).toEqual(NETWORK_ABI);
    // Canonical hit resolves in a single query — no alias fallback needed.
    expect(contractNetworkFindUnique).not.toHaveBeenCalled();
  });

  it('falls back to SEP-41 when the deployment has no ABI and the contract is a token', async () => {
    contractFindUnique.mockResolvedValue({
      isToken: true,
      abi: null,
      networkDeployments: [{ abi: null }],
    });

    expect(await getContractAbi('CTOKEN', 'devnet')).toBe(SEP41_ABI);
  });

  it('falls back to the canonical ABI when the deployment has none', async () => {
    const canonicalAbi = { functions: [{ name: 'transfer', inputs: [] }] };
    contractFindUnique.mockResolvedValue({
      isToken: false,
      abi: canonicalAbi,
      networkDeployments: [{ abi: null }],
    });

    expect(await getContractAbi('CCANON', 'mainnet')).toEqual(canonicalAbi);
  });

  it('resolves a network-specific alias address via the deployment table', async () => {
    contractFindUnique.mockResolvedValue(null);
    contractNetworkFindUnique.mockResolvedValue({
      abi: ALIAS_ABI,
      contract: { isToken: false, abi: null },
    });

    const abi = await getContractAbi('CALIAS', 'mainnet');

    expect(contractNetworkFindUnique).toHaveBeenCalledWith({
      where: { address_network: { address: 'CALIAS', network: 'mainnet' } },
      include: { contract: true },
    });
    expect(abi).toEqual(ALIAS_ABI);
  });

  it('stays backwards compatible when no network is passed', async () => {
    contractFindUnique.mockResolvedValue({ isToken: false, abi: NETWORK_ABI });

    const abi = await getContractAbi('CLEGACY');

    expect(contractFindUnique).toHaveBeenCalledWith({ where: { address: 'CLEGACY' } });
    expect(contractNetworkFindUnique).not.toHaveBeenCalled();
    expect(abi).toEqual(NETWORK_ABI);
  });

  it('returns null when nothing resolves', async () => {
    contractFindUnique.mockResolvedValue(null);
    contractNetworkFindUnique.mockResolvedValue(null);
    expect(await getContractAbi('CMISSING', 'mainnet')).toBeNull();
  });
});

describe('getContractRecord', () => {
  it('resolves a network alias through the deployment table', async () => {
    const contract = { id: 'c1', address: 'CCANON', name: 'Canonical' };
    contractFindUnique.mockResolvedValue(null);
    contractNetworkFindUnique.mockResolvedValue({ contract });

    const record = await getContractRecord('CMAINNETADDR', 'mainnet');

    expect(record).toBe(contract);
  });

  it('falls back to the address lookup without a network', async () => {
    const contract = { id: 'c2', address: 'CPLAIN', name: 'Plain' };
    contractFindUnique.mockResolvedValue(contract);

    const record = await getContractRecord('CPLAIN');

    expect(contractNetworkFindUnique).not.toHaveBeenCalled();
    expect(record).toBe(contract);
  });
});

describe('getProtocolDeployments', () => {
  it('returns deployments across networks with their canonical contract', async () => {
    contractNetworkFindMany.mockResolvedValue([
      {
        address: 'CMAIN',
        network: 'mainnet',
        abiVersion: '1.0.0',
        abiHash: null,
        version: 'v1',
        wasmHash: 'abc',
        protocolKey: 'usdc',
        isCanonical: true,
        deployedAtLedger: 10,
        contract: { address: 'CCANON', name: 'USD Coin' },
      },
    ]);

    const deployments = await getProtocolDeployments('usdc');

    expect(contractNetworkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { protocolKey: 'usdc' } }),
    );
    expect(deployments).toEqual([
      {
        address: 'CMAIN',
        network: 'mainnet',
        abiVersion: '1.0.0',
        abiHash: null,
        version: 'v1',
        wasmHash: 'abc',
        protocolKey: 'usdc',
        isCanonical: true,
        deployedAtLedger: 10,
        contractAddress: 'CCANON',
        name: 'USD Coin',
      },
    ]);
  });
});
