import { xdr, Address, StrKey, nativeToScVal } from '@stellar/stellar-sdk';

export type ScValInput =
  | { type: 'void' }
  | { type: 'bool'; value: boolean }
  | { type: 'u32'; value: number }
  | { type: 'i32'; value: number }
  | { type: 'u64'; value: string | number }
  | { type: 'i64'; value: string | number }
  | { type: 'u128'; value: string }
  | { type: 'i128'; value: string }
  | { type: 'string'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'address'; value: string }
  | { type: 'bytes'; value: string }
  | { type: 'vec'; items: ScValInput[] }
  | { type: 'map'; entries: { key: ScValInput; value: ScValInput }[] }
  | { type: 'option'; inner: ScValInput | null }
  | { type: 'native'; value: unknown };

export class ScValValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScValValidationError';
  }
}

export function encodeScVal(input: ScValInput): xdr.ScVal {
  switch (input.type) {
    case 'void':
      return xdr.ScVal.scvVoid();

    case 'bool':
      return xdr.ScVal.scvBool(input.value);

    case 'u32': {
      if (!Number.isInteger(input.value) || input.value < 0 || input.value > 0xffffffff) {
        throw new ScValValidationError(`u32 value out of range: ${input.value}`);
      }
      return xdr.ScVal.scvU32(input.value);
    }

    case 'i32': {
      if (!Number.isInteger(input.value) || input.value < -2147483648 || input.value > 2147483647) {
        throw new ScValValidationError(`i32 value out of range: ${input.value}`);
      }
      return xdr.ScVal.scvI32(input.value);
    }

    case 'u64': {
      const n = BigInt(input.value);
      if (n < 0n || n > 18446744073709551615n) {
        throw new ScValValidationError(`u64 value out of range: ${input.value}`);
      }
      return xdr.ScVal.scvU64(new xdr.Uint64(n));
    }

    case 'i64': {
      const n = BigInt(input.value);
      if (n < -9223372036854775808n || n > 9223372036854775807n) {
        throw new ScValValidationError(`i64 value out of range: ${input.value}`);
      }
      return xdr.ScVal.scvI64(new xdr.Int64(n));
    }

    case 'u128': {
      const n = BigInt(input.value);
      if (n < 0n || n > 2n ** 128n - 1n) {
        throw new ScValValidationError(`u128 value out of range`);
      }
      const hi = n >> 64n;
      const lo = n & 0xffffffffffffffffn;
      return xdr.ScVal.scvU128(
        new xdr.UInt128Parts({ hi: new xdr.Uint64(hi), lo: new xdr.Uint64(lo) }),
      );
    }

    case 'i128': {
      const n = BigInt(input.value);
      if (n < -(2n ** 127n) || n > 2n ** 127n - 1n) {
        throw new ScValValidationError(`i128 value out of range`);
      }
      const unsigned = n < 0n ? n + 2n ** 128n : n;
      const hi = unsigned >> 64n;
      const lo = unsigned & 0xffffffffffffffffn;
      return xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: new xdr.Int64(BigInt.asIntN(64, hi)), lo: new xdr.Uint64(lo) }),
      );
    }

    case 'string':
      return xdr.ScVal.scvString(Buffer.from(input.value, 'utf8'));

    case 'symbol':
      return xdr.ScVal.scvSymbol(input.value);

    case 'address': {
      const val = input.value.trim();
      try {
        if (val.startsWith('G') && StrKey.isValidEd25519PublicKey(val)) {
          const raw = StrKey.decodeEd25519PublicKey(val);
          return Address.account(raw).toScVal();
        }
        if (val.startsWith('C')) {
          const raw = StrKey.decodeContract(val);
          return Address.contract(raw).toScVal();
        }
        throw new ScValValidationError(`Invalid Stellar address (must be G or C prefix): ${val}`);
      } catch (e) {
        if (e instanceof ScValValidationError) throw e;
        throw new ScValValidationError(`Invalid Stellar address: ${val}`);
      }
    }

    case 'bytes': {
      const hex = input.value.replace(/^0x/, '');
      if (!/^[0-9a-fA-F]*$/.test(hex)) {
        throw new ScValValidationError(`Invalid hex for bytes: ${input.value}`);
      }
      return xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
    }

    case 'vec':
      return xdr.ScVal.scvVec(input.items.map(encodeScVal));

    case 'map': {
      const entries = input.entries.map(
        (e) => new xdr.ScMapEntry({ key: encodeScVal(e.key), val: encodeScVal(e.value) }),
      );
      return xdr.ScVal.scvMap(entries);
    }

    case 'option':
      if (input.inner === null) return xdr.ScVal.scvVoid();
      return encodeScVal(input.inner);

    case 'native':
      return nativeToScVal(input.value);

    default: {
      const _exhaustive: never = input;
      throw new ScValValidationError(`Unknown ScVal type: ${(_exhaustive as any).type}`);
    }
  }
}

export function decodeScVal(val: xdr.ScVal): unknown {
  const type = val.switch().name;
  switch (type) {
    case 'scvVoid': return null;
    case 'scvBool': return val.b();
    case 'scvU32': return val.u32();
    case 'scvI32': return val.i32();
    case 'scvU64': return String(val.u64().toBigInt());
    case 'scvI64': return String(val.i64().toBigInt());
    case 'scvU128': {
      const u = val.u128();
      const hi = u.hi().toBigInt();
      const lo = u.lo().toBigInt();
      return String((hi << 64n) | lo);
    }
    case 'scvI128': {
      const i = val.i128();
      const hiSigned = i.hi().toBigInt();
      const lo = i.lo().toBigInt();
      const raw = (hiSigned << 64n) | (lo & 0xffffffffffffffffn);
      return String(raw);
    }
    case 'scvString': return val.str().toString('utf8');
    case 'scvSymbol': return val.sym().toString();
    case 'scvBytes': return '0x' + val.bytes().toString('hex');
    case 'scvAddress': return Address.fromScVal(val).toString();
    case 'scvVec': return (val.vec() ?? []).map(decodeScVal);
    case 'scvMap': {
      const result: Record<string, unknown> = {};
      for (const entry of val.map() ?? []) {
        result[String(decodeScVal(entry.key()))] = decodeScVal(entry.val());
      }
      return result;
    }
    case 'scvError': {
      const err = val.error();
      return { error: true, type: err.switch().name, code: err.value() };
    }
    default:
      return { type, raw: val.toXDR('base64') };
  }
}
