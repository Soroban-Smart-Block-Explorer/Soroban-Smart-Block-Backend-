import { describe, it, expect, vi, beforeEach } from 'vitest';

// config validates the active profile at import time; keep this test hermetic.
process.env.TESTNET_DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.STELLAR_NETWORK ??= 'testnet';

const { contractUpsert, contractNetworkUpsert } = vi.hoisted(() => ({
  contractUpsert: vi.fn(),
  contractNetworkUpsert: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prismaRead: {
    contract: { findUnique: vi.fn(), findMany: vi.fn() },
    contractNetwork: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  prismaWrite: {
    contract: { upsert: contractUpsert },
    contractNetwork: { upsert: contractNetworkUpsert },
  },
}));

const ADDR_TESTNET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ADDR_MAINNET = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4';

beforeEach(() => {
  vi.clearAllMocks();
  contractUpsert.mockResolvedValue({ id: 'contract-1', address: ADDR_TESTNET });
  contractNetworkUpsert.mockResolvedValue({ id: 'deployment-1', address: ADDR_MAINNET });
});

describe('registerContractMetadata', () => {
  it('preserves address-only registration when no network is given', async () => {
    const { registerContractMetadata } = await import('../../src/api/contracts');

    const result = await registerContractMetadata({
      address: ADDR_TESTNET,
      name: 'Router',
      abi: { functions: [] },
    });

    expect(contractUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: ADDR_TESTNET } }),
    );
    expect(contractNetworkUpsert).not.toHaveBeenCalled();
    expect(result.deployment).toBeNull();
  });

  it('dedupes on (address, network) and links the canonical contract', async () => {
    const { registerContractMetadata } = await import('../../src/api/contracts');

    const result = await registerContractMetadata({
      address: ADDR_MAINNET,
      network: 'mainnet',
      canonicalAddress: ADDR_TESTNET,
      abiVersion: '1.2.0',
      version: 'v2',
      wasmHash: 'deadbeef',
      protocolKey: 'my-protocol',
      isCanonical: true,
      deployedAtLedger: 42,
    });

    // Canonical record is keyed by canonicalAddress, not the network address.
    expect(contractUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: ADDR_TESTNET } }),
    );

    expect(contractNetworkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { address_network: { address: ADDR_MAINNET, network: 'mainnet' } },
        create: expect.objectContaining({
          address: ADDR_MAINNET,
          network: 'mainnet',
          contractId: 'contract-1',
          abiVersion: '1.2.0',
          version: 'v2',
          wasmHash: 'deadbeef',
          protocolKey: 'my-protocol',
          isCanonical: true,
          deployedAtLedger: 42,
        }),
      }),
    );

    expect(result.deployment).toEqual({ id: 'deployment-1', address: ADDR_MAINNET });
  });

  it('re-registers the same (address, network) through the unique upsert selector', async () => {
    const { registerContractMetadata } = await import('../../src/api/contracts');

    await registerContractMetadata({ address: ADDR_MAINNET, network: 'mainnet' });
    await registerContractMetadata({
      address: ADDR_MAINNET,
      network: 'mainnet',
      abiVersion: '2.0.0',
    });

    const [first, second] = contractNetworkUpsert.mock.calls;
    expect(first[0].where).toEqual({
      address_network: { address: ADDR_MAINNET, network: 'mainnet' },
    });
    expect(second[0].where).toEqual(first[0].where);
    expect(second[0].update).toEqual(
      expect.objectContaining({ contractId: 'contract-1', abiVersion: '2.0.0' }),
    );
  });

  it('defaults isCanonical to false and omits absent version fields', async () => {
    const { registerContractMetadata } = await import('../../src/api/contracts');

    await registerContractMetadata({ address: ADDR_MAINNET, network: 'mainnet' });

    const create = contractNetworkUpsert.mock.calls[0][0].create;
    expect(create.isCanonical).toBe(false);
    expect(create.abiVersion).toBeUndefined();
    expect(create.protocolKey).toBeUndefined();
  });
});
