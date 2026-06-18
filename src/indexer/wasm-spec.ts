import { xdr, contract } from '@stellar/stellar-sdk';
import { rpc } from './rpc';

const SECTION_NAME = 'contractspecv0';

/**
 * Parse a Wasm binary and extract all `contractspecv0` custom section payloads.
 * Each payload is a sequence of XDR-encoded ScSpecEntry values (no length prefix).
 */
export function parseWasmSpec(wasm: Buffer): xdr.ScSpecEntry[] {
  const entries: xdr.ScSpecEntry[] = [];
  let offset = 0;

  // Wasm magic + version (8 bytes)
  if (wasm.length < 8) throw new Error('Invalid Wasm: too short');
  offset = 8;

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const [sectionSize, sizeLen] = readUleb128(wasm, offset);
    offset += sizeLen;
    const sectionEnd = offset + sectionSize;

    if (sectionId === 0) {
      // Custom section: name length + name + payload
      const [nameLen, nameLenBytes] = readUleb128(wasm, offset);
      const nameStart = offset + nameLenBytes;
      const name = wasm.slice(nameStart, nameStart + nameLen).toString('utf8');
      const payloadStart = nameStart + nameLen;

      if (name === SECTION_NAME) {
        const payload = wasm.slice(payloadStart, sectionEnd);
        // Payload is a sequence of back-to-back XDR ScSpecEntry values
        let pos = 0;
        while (pos < payload.length) {
          const entry = xdr.ScSpecEntry.fromXDR(payload.slice(pos));
          entries.push(entry);
          pos += entry.toXDR().length;
        }
      }
    }

    offset = sectionEnd;
  }

  return entries;
}

/** Read an unsigned LEB128 integer; returns [value, bytesConsumed]. */
function readUleb128(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const byte = buf[offset + bytesRead++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [result, bytesRead];
}

/**
 * Fetch the Wasm bytecode for a contract and extract its on-chain spec.
 * Returns the JSON schema produced by `contract.Spec`, or null if unavailable.
 */
export async function fetchContractSpec(contractAddress: string): Promise<object | null> {
  let wasm: Buffer;
  try {
    wasm = await rpc.getContractWasmByContractId(contractAddress);
  } catch {
    return null;
  }

  let specEntries: xdr.ScSpecEntry[];
  try {
    specEntries = parseWasmSpec(wasm);
  } catch {
    return null;
  }

  if (specEntries.length === 0) return null;

  const spec = new contract.Spec(specEntries);
  return spec.jsonSchema();
}
