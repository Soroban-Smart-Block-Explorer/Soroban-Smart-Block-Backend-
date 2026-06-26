import { prismaWrite as prisma } from '../db';

// secp256r1 (P-256) OID prefix in DER-encoded SubjectPublicKeyInfo
// 0x04 = uncompressed point prefix; preceded by the SPKI header for P-256
const P256_UNCOMPRESSED_PREFIX = Buffer.from('04', 'hex');

// Known passkey platform labels based on public key coordinate patterns.
// In practice, the platform is not deterministically derivable from the key
// alone; we label all secp256r1 keys as passkey-capable and note both platforms.
const PASSKEY_LABEL = 'Signed via Apple iCloud Keychain / Google Passkey';

/**
 * Inspect a transaction's authorization entries for secp256r1 signatures.
 * Soroban custom accounts can use secp256r1 via the `__check_auth` interface.
 * The signature payload is a ScVal map containing `public_key` (33 or 65 bytes)
 * and `signature` (64 bytes r||s).
 *
 * Detection strategy:
 *  1. Decode the transaction envelope XDR.
 *  2. Walk SorobanAuthorizationEntry.credentials.address.signature ScVal.
 *  3. If any bytes field is 65 bytes starting with 0x04 (uncompressed P-256),
 *     or 33 bytes starting with 0x02/0x03 (compressed P-256), flag as secp256r1.
 */
export async function inspectSignature(
  txHash: string,
  ledgerSequence: number,
  rawXdr: string,
): Promise<void> {
  if (!rawXdr) return;

  let curveType = 'ed25519';
  let isPasskey = false;
  let pubKeyX: string | undefined;
  let pubKeyY: string | undefined;
  let label: string | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { xdr } = require('@stellar/stellar-sdk');
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    const ops = envelope.v1?.tx?.operations() ?? envelope.v0?.tx?.operations() ?? [];

    outer: for (const op of ops) {
      const body = op.body();
      const invokeOp = body?.invokeHostFunction?.();
      if (!invokeOp) continue;

      const authEntries: any[] = invokeOp.auth?.() ?? [];
      for (const entry of authEntries) {
        const creds = entry.credentials?.();
        const addrCreds = creds?.address?.();
        if (!addrCreds) continue;

        const sigScVal = addrCreds.signature?.();
        if (!sigScVal) continue;

        // Walk the ScVal map looking for a bytes field that looks like a P-256 key
        const pubKeyBytes = extractPubKeyBytes(sigScVal);
        if (!pubKeyBytes) continue;

        if (isP256Key(pubKeyBytes)) {
          curveType = 'secp256r1';
          isPasskey = true;
          label = PASSKEY_LABEL;
          const coords = extractCoordinates(pubKeyBytes);
          pubKeyX = coords.x;
          pubKeyY = coords.y;
          break outer;
        }
      }
    }
  } catch {
    // XDR parse failure — default to ed25519, still record
  }

  await prisma.signatureInspection.upsert({
    where: { transactionHash: txHash },
    update: { curveType, isPasskey, pubKeyX, pubKeyY, label },
    create: {
      transactionHash: txHash,
      ledgerSequence,
      curveType,
      isPasskey,
      pubKeyX,
      pubKeyY,
      label,
    },
  });
}

function extractPubKeyBytes(scVal: any): Buffer | null {
  try {
    // ScVal can be a map; iterate entries looking for bytes values
    const map: any[] = scVal.map?.() ?? [];
    for (const entry of map) {
      const val = entry.val?.();
      const bytes: Buffer | undefined = val?.bytes?.();
      if (bytes && (bytes.length === 33 || bytes.length === 65)) return bytes;
    }
    // Direct bytes ScVal
    const direct: Buffer | undefined = scVal.bytes?.();
    if (direct && (direct.length === 33 || direct.length === 65)) return direct;
  } catch {
    // ignore
  }
  return null;
}

function isP256Key(bytes: Buffer): boolean {
  if (bytes.length === 65 && bytes[0] === 0x04) return true; // uncompressed
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) return true; // compressed
  return false;
}

function extractCoordinates(bytes: Buffer): { x: string; y: string } {
  if (bytes.length === 65) {
    // Uncompressed: 0x04 || X (32 bytes) || Y (32 bytes)
    return {
      x: bytes.slice(1, 33).toString('hex'),
      y: bytes.slice(33, 65).toString('hex'),
    };
  }
  // Compressed: only X is available directly
  return {
    x: bytes.slice(1, 33).toString('hex'),
    y: '',
  };
}
