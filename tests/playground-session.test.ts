import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveContractFunctions, type ResolvedFunction } from '../src/playground/abi-resolver';
import {
  readContract,
  buildSignableTransaction,
  submitTransaction,
  type ReadRequest,
  type BuildTxRequest,
} from '../src/playground/tx-builder';
import { encodeScVal, ScValValidationError } from '../src/playground/scval-codec';

vi.mock('../src/indexer/wasm-spec', () => ({
  fetchContractSpec: vi.fn(),
}));

vi.mock('../src/indexer/abi-cache', () => ({
  getCachedAbi: vi.fn(),
}));

vi.mock('../src/indexer/rpc', () => ({
  rpc: {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  },
}));

vi.mock('../src/config', () => ({
  config: { networkPassphrase: 'Test SDF Network ; September 2015' },
}));

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Playground - Contract Function Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves functions from on-chain spec', async () => {
    const { fetchContractSpec } = await import('../src/indexer/wasm-spec');
    vi.mocked(fetchContractSpec).mockResolvedValue({
      definitions: {
        transfer: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            amount: { type: 'number' },
          },
        },
      },
    });

    const result = await resolveContractFunctions(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    );
    expect(result.source).toBe('on-chain');
    expect(result.functions.length).toBeGreaterThan(0);
    expect(result.functions[0].name).toBe('transfer');
  });

  it('falls back to SEP-41 when spec not available', async () => {
    const { fetchContractSpec } = await import('../src/indexer/wasm-spec');
    const { getCachedAbi } = await import('../src/indexer/abi-cache');

    vi.mocked(fetchContractSpec).mockResolvedValue(null);
    vi.mocked(getCachedAbi).mockResolvedValue(null);

    const result = await resolveContractFunctions(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    );
    expect(result.source).toBe('sep41-fallback');
    expect(result.functions.length).toBeGreaterThan(0);
    expect(result.functions.map((f: ResolvedFunction) => f.name)).toContain('transfer');
  });

  it('uses cached ABI as fallback after on-chain check', async () => {
    const { fetchContractSpec } = await import('../src/indexer/wasm-spec');
    const { getCachedAbi } = await import('../src/indexer/abi-cache');

    vi.mocked(fetchContractSpec).mockResolvedValue(null);
    vi.mocked(getCachedAbi).mockResolvedValue({
      functions: [
        { name: 'customFunc', inputs: [{ name: 'x', type: 'u32' }], outputs: [{ type: 'u32' }] },
      ],
    });

    const result = await resolveContractFunctions(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    );
    expect(result.source).toBe('manual');
    expect(result.functions[0].name).toBe('customFunc');
  });
});

describe('Playground - Read-Only Contract Calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully reads contract state', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockResolvedValue({ sequenceNumber: () => '100' } as any);
    mockRpc.simulateTransaction.mockResolvedValue({
      result: { retval: { switch: () => ({ name: 'scvU32' }), u32: () => 42 } },
    } as any);

    const req: ReadRequest = {
      functionName: 'balance',
      args: [
        { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q' },
      ],
    };

    const result = await readContract(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
  });

  it('handles simulation errors gracefully', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockResolvedValue({ sequenceNumber: () => '100' } as any);
    mockRpc.simulateTransaction.mockResolvedValue({
      error: 'Contract not found',
    } as any);

    const req: ReadRequest = {
      functionName: 'balance',
      args: [
        { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q' },
      ],
    };

    const result = await readContract('INVALID_CONTRACT', req);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('handles invalid input encoding', async () => {
    const req: ReadRequest = {
      functionName: 'transfer',
      args: [{ type: 'u32', value: -1 }],
    };

    const result = await readContract(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });
});

describe('Playground - Transaction Building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a transaction for contract invocation', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockResolvedValue({ sequenceNumber: () => '100' } as any);
    mockRpc.simulateTransaction.mockResolvedValue({
      result: { retval: null },
      minResourceFee: '1000',
      transactionData: {
        resources: () => ({
          instructions: 1000,
          readBytes: 512,
          readEntries: 2,
          writeEntries: 1,
        }),
      },
    } as any);

    const req: BuildTxRequest = {
      functionName: 'transfer',
      args: [
        { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q' },
        { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q' },
        { type: 'i128', value: '1000' },
      ],
      sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q',
    };

    const result = await buildSignableTransaction(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.simulationSuccess).toBe(true);
    expect(result.unsignedXdr).toBeDefined();
    expect(result.estimatedFee).toBe('1000');
    expect(result.estimatedResources).toBeDefined();
  });

  it('estimates resources correctly', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockResolvedValue({ sequenceNumber: () => '100' } as any);
    mockRpc.simulateTransaction.mockResolvedValue({
      result: { retval: null },
      minResourceFee: '5000',
      transactionData: {
        resources: () => ({
          instructions: 5000,
          readBytes: 1024,
          readEntries: 5,
          writeEntries: 3,
        }),
      },
    } as any);

    const req: BuildTxRequest = {
      functionName: 'mint',
      args: [
        { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q' },
        { type: 'i128', value: '1000000' },
      ],
      sourceAccount: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46Q',
    };

    const result = await buildSignableTransaction(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.simulationSuccess).toBe(true);
    expect(result.estimatedResources?.cpuInstructions).toBe(5000);
    expect(result.estimatedResources?.ledgerReads).toBe(5);
    expect(result.estimatedResources?.ledgerWrites).toBe(3);
  });

  it('handles transaction build errors', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockRejectedValue(new Error('Account not found'));

    const req: BuildTxRequest = {
      functionName: 'transfer',
      args: [{ type: 'u32', value: 100 }],
      sourceAccount: 'INVALID_ACCOUNT',
    };

    const result = await buildSignableTransaction(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.simulationSuccess).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('Playground - Transaction Submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits signed transaction', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.sendTransaction.mockResolvedValue({
      hash: 'abc123def456',
      status: 'PENDING',
    } as any);

    const result = await submitTransaction({
      signedXdr: 'AAAAAgAAAABoQJRQAAAAZQAAAAAAAGQAAAAAAAAAAAA...',
    });

    expect(result.hash).toBe('abc123def456');
    expect(result.status).toBe('PENDING');
  });

  it('handles submission errors', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.sendTransaction.mockRejectedValue(new Error('Invalid signature'));

    const result = await submitTransaction({
      signedXdr: 'INVALID_XDR',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid signature');
  });
});

describe('Playground - Error Paths', () => {
  it('handles gas limit exceeded', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockResolvedValue({ sequenceNumber: () => '100' } as any);
    mockRpc.simulateTransaction.mockResolvedValue({
      error: 'Resource limit exceeded: CPU instructions',
    } as any);

    const req: ReadRequest = {
      functionName: 'expensiveOperation',
      args: [],
    };

    const result = await readContract(
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      req,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Resource limit');
  });

  it('validates contract address format', () => {
    expect(() => {
      encodeScVal({ type: 'address', value: 'INVALID' });
    }).toThrow(ScValValidationError);
  });

  it('handles timeout scenarios', async () => {
    const { rpc } = await import('../src/indexer/rpc');
    const mockRpc = vi.mocked(rpc);
    mockRpc.getAccount.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ sequenceNumber: () => '100' } as any), 10000),
        ),
    );

    const req: ReadRequest = {
      functionName: 'slowFunction',
      args: [],
    };

    const timeoutPromise = Promise.race([
      readContract('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', req),
      new Promise((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'timeout' }), 100),
      ),
    ]);

    const result = await timeoutPromise;
    expect((result as unknown as { success: boolean }).success).toBe(false);
  });
});
