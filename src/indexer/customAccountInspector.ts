import { xdr, StrKey } from '@stellar/stellar-sdk';
import { scValToJson } from './xdr-parser';

/**
 * Inspect a transaction envelope for Soroban Custom Account "__check_auth"
 * invocations and extract the contract ID, invocation mode and payload args.
 *
 * This analyzer does not write to the DB; it logs a structured summary so
 * callers can choose how to persist or surface the findings.
 */
export async function inspectCustomAccount(
  txHash: string,
  ledgerSequence: number,
  rawXdr: string,
): Promise<void> {
  if (!rawXdr) return;

  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(rawXdr, 'base64');
    const ops = envelope.v1()?.tx()?.operations() ?? envelope.v0()?.tx()?.operations() ?? [];

    outer: for (const op of ops) {
      const body = op.body();
      const invokeOp = (body as any).invokeHostFunction();
      if (!invokeOp) continue;

      const authEntries: any[] = invokeOp.auth?.() ?? [];
      for (const entry of authEntries) {
        const rootInv = entry.rootInvocation?.();
        if (!rootInv) continue;
        const fn = rootInv.function?.();
        if (!fn) continue;

        if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') continue;
        const contractFn = fn.contractFn?.();
        if (!contractFn) continue;

        const functionName = contractFn.functionName?.()?.toString?.() ?? '';

        // Target Soroban custom account check interface
        if (functionName !== '__check_auth') continue;

        const contractId = StrKey.encodeContract(contractFn.contractAddress().contractId());

        // Decode args
        const args = (contractFn.args?.() ?? []).map((a: any, i: number) => {
          try {
            return { index: i, ...scValToJson(a) };
          } catch {
            return { index: i, type: 'unknown', value: null };
          }
        });

        // Extract credentials.address information (if present)
        const creds = entry.credentials?.();
        let credAddress: string | null = null;
        let credType: 'account' | 'contract' | 'unknown' = 'unknown';
        let nonce: string | null = null;
        let signaturePayload: unknown = null;

        try {
          if (creds?.switch?.()?.name === 'sorobanCredentialsAddress') {
            const addrCreds = creds.address?.();
            const scAddr = addrCreds.address?.();
            if (scAddr) {
              const addrType = scAddr.switch().name;
              if (addrType === 'scAddressTypeAccount') {
                credType = 'account';
                credAddress = StrKey.encodeEd25519PublicKey(scAddr.accountId().ed25519());
              } else if (addrType === 'scAddressTypeContract') {
                credType = 'contract';
                credAddress = StrKey.encodeContract(scAddr.contractId());
              }
            }
            if (typeof addrCreds.nonce?.() !== 'undefined') {
              nonce = String(addrCreds.nonce().toString());
            }
            const sigScVal = addrCreds.signature?.();
            if (sigScVal) {
              try {
                signaturePayload = scValToJson(sigScVal).value;
              } catch {
                signaturePayload = null;
              }
            }
          }
        } catch {
          // noop
        }

        const result = {
          txHash,
          ledgerSequence,
          contractId,
          invocationMode: '__check_auth',
          args,
          credentials: { type: credType, address: credAddress, nonce, signaturePayload },
        };

        // Log concise structured result for downstream consumption
        try {
          console.info('[custom-account-inspector]', JSON.stringify(result));
        } catch {
          console.info('[custom-account-inspector]', result);
        }

        break outer;
      }
    }
  } catch (err) {
    // Non-fatal — do not block indexing
    console.warn(
      `[custom-account-inspector] parse failed for ${txHash}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
