import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeScValXdr } from '../src/archive/scval-decoder';
import { xdr } from '@stellar/stellar-sdk';

vi.mock('../src/db', () => ({
  prisma: {
    contractStateChange: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

describe('decodeScValXdr', () => {
  it('decodes a u32 ScVal from XDR base64', () => {
    const val = xdr.ScVal.scvU32(42);
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('42');
  });

  it('decodes a string ScVal', () => {
    const val = xdr.ScVal.scvString(Buffer.from('hello', 'utf8'));
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('"hello"');
  });

  it('decodes a symbol ScVal', () => {
    const val = xdr.ScVal.scvSymbol('transfer');
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('transfer');
  });

  it('decodes a bool ScVal', () => {
    const val = xdr.ScVal.scvBool(true);
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('true');
  });

  it('decodes void ScVal as "null"', () => {
    const val = xdr.ScVal.scvVoid();
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('null');
  });

  it('decodes bytes ScVal to hex', () => {
    const val = xdr.ScVal.scvBytes(Buffer.from('deadbeef', 'hex'));
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('0xdeadbeef');
  });

  it('returns input as-is for invalid base64', () => {
    const result = decodeScValXdr('not-valid-xdr!!!');
    expect(result).toBe('not-valid-xdr!!!');
  });

  it('decodes vec ScVal', () => {
    const val = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2)]);
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('[1, 2]');
  });

  it('decodes map ScVal', () => {
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('key'), val: xdr.ScVal.scvU32(99) }),
    ]);
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('{key: 99}');
  });

  it('decodes i32 ScVal', () => {
    const val = xdr.ScVal.scvI32(-5);
    const b64 = val.toXDR('base64');
    const decoded = decodeScValXdr(b64);
    expect(decoded).toBe('-5');
  });
});

describe('archive captureStateChangesForTransaction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls prisma.contractStateChange.create for each change', async () => {
    const { captureStateChangesForTransaction } = await import('../src/archive/archiver');
    const { prisma } = await import('../src/db');

    const changes = [
      { key: 'key1', before: undefined, after: 'value1' },
      { key: 'key2', before: 'old', after: 'new' },
    ];

    const saved = await captureStateChangesForTransaction(
      'CONTRACT1',
      'TX_HASH1',
      100,
      new Date('2024-01-01'),
      changes,
    );

    expect(saved).toBe(2);
    expect(prisma.contractStateChange.create).toHaveBeenCalledTimes(2);
  });

  it('sets operation to "create" when no before value', async () => {
    const { captureStateChangesForTransaction } = await import('../src/archive/archiver');
    const { prisma } = await import('../src/db');
    vi.mocked(prisma.contractStateChange.create).mockClear();

    await captureStateChangesForTransaction('C', 'TX', 1, new Date(), [
      { key: 'k', after: 'v' },
    ]);

    expect(prisma.contractStateChange.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'create' }) }),
    );
  });

  it('sets operation to "delete" when no after value', async () => {
    const { captureStateChangesForTransaction } = await import('../src/archive/archiver');
    const { prisma } = await import('../src/db');
    vi.mocked(prisma.contractStateChange.create).mockClear();

    await captureStateChangesForTransaction('C', 'TX', 1, new Date(), [
      { key: 'k', before: 'old' },
    ]);

    expect(prisma.contractStateChange.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'delete' }) }),
    );
  });

  it('sets operation to "update" when both before and after', async () => {
    const { captureStateChangesForTransaction } = await import('../src/archive/archiver');
    const { prisma } = await import('../src/db');
    vi.mocked(prisma.contractStateChange.create).mockClear();

    await captureStateChangesForTransaction('C', 'TX', 1, new Date(), [
      { key: 'k', before: 'old', after: 'new' },
    ]);

    expect(prisma.contractStateChange.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'update' }) }),
    );
  });
});
