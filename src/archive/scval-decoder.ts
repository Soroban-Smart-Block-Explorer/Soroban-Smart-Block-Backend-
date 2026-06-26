import { xdr, Address } from '@stellar/stellar-sdk';

export function decodeScValXdr(base64: string): string {
  try {
    const val = xdr.ScVal.fromXDR(base64, 'base64');
    return humanReadableScVal(val);
  } catch {
    return base64;
  }
}

export function humanReadableScVal(val: xdr.ScVal): string {
  const type = val.switch().name;
  switch (type) {
    case 'scvVoid': return 'null';
    case 'scvBool': return String(val.b());
    case 'scvU32': return String(val.u32());
    case 'scvI32': return String(val.i32());
    case 'scvU64': return val.u64().toBigInt().toString();
    case 'scvI64': return val.i64().toBigInt().toString();
    case 'scvU128': {
      const u = val.u128();
      return ((u.hi().toBigInt() << 64n) | u.lo().toBigInt()).toString();
    }
    case 'scvI128': {
      const i = val.i128();
      const hi = i.hi().toBigInt();
      const lo = i.lo().toBigInt();
      return (hi < 0n ? (hi << 64n) - lo : (hi << 64n) | lo).toString();
    }
    case 'scvString': return `"${val.str().toString('utf8')}"`;
    case 'scvSymbol': return val.sym().toString();
    case 'scvBytes': return '0x' + val.bytes().toString('hex');
    case 'scvAddress': {
      try {
        return Address.fromScVal(val).toString();
      } catch {
        return '<address>';
      }
    }
    case 'scvVec': {
      const items = (val.vec() ?? []).map(humanReadableScVal);
      return `[${items.join(', ')}]`;
    }
    case 'scvMap': {
      const pairs = (val.map() ?? []).map(
        (e) => `${humanReadableScVal(e.key())}: ${humanReadableScVal(e.val())}`,
      );
      return `{${pairs.join(', ')}}`;
    }
    case 'scvError':
      return `Error(${val.error().switch().name})`;
    default:
      return `${type}`;
  }
}
