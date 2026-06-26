import { xdr, StrKey } from '@stellar/stellar-sdk';

export interface AuthSnapshot {
  entryXdr: string;
  signerAddress: string;
  nonce: string | null;
  contractId: string;
  functionName: string;
  jsSnippet: string;
  rustSnippet: string;
}

function scAddressToString(addr: xdr.ScAddress): string {
  return addr.switch().name === 'scAddressTypeAccount'
    ? StrKey.encodeEd25519PublicKey(addr.accountId().ed25519())
    : StrKey.encodeContract(addr.contractId());
}

function buildJsSnippet(
  xdrStr: string,
  signer: string,
  nonce: string | null,
  contractId: string,
  fn: string,
): string {
  return `\
// Auth snippet (JS / @stellar/stellar-sdk) — signer: ${signer}  contract: ${contractId}  fn: ${fn}
import { xdr, Keypair, hash } from '@stellar/stellar-sdk';
const entry = xdr.SorobanAuthorizationEntry.fromXDR('${xdrStr}', 'base64');
entry.credentials().address().signatureExpirationLedger(CURRENT_LEDGER + 100);${nonce !== null ? `  // nonce: ${nonce}` : ''}
const keypair = Keypair.fromSecret('YOUR_SECRET_KEY');
const preimage = xdr.HashIdPreimage.fromXDR(xdr.HashIdPreimageSorobanAuthorization.toXDR(
  new xdr.HashIdPreimageSorobanAuthorization({
    networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
    nonce: entry.credentials().address().nonce(),
    signatureExpirationLedger: entry.credentials().address().signatureExpirationLedger(),
    invocation: entry.rootInvocation(),
  })
));
const sig = keypair.sign(hash(preimage));
entry.credentials().address().signature(xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('public_key'), val: xdr.ScVal.scvBytes(keypair.rawPublicKey()) }),
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'),  val: xdr.ScVal.scvBytes(sig) }),
]));
op.body().invokeHostFunctionOp().auth([entry]);`;
}

function buildRustSnippet(
  xdrStr: string,
  signer: string,
  nonce: string | null,
  contractId: string,
  fn: string,
): string {
  return `\
// Auth snippet (Rust / soroban-sdk) — signer: ${signer}  contract: ${contractId}  fn: ${fn}
let mut entry = SorobanAuthorizationEntry::from_xdr_base64("${xdrStr}", Limits::none()).unwrap();
if let SorobanCredentials::Address(ref mut creds) = entry.credentials {
    creds.signature_expiration_ledger = current_ledger + 100;${nonce !== null ? `  // nonce: ${nonce}` : ''}
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: Hash(env.ledger().network_id().to_array()),
        nonce: creds.nonce,
        signature_expiration_ledger: creds.signature_expiration_ledger,
        invocation: entry.root_invocation.clone(),
    });
    let payload = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap());
    let sig = keypair.sign(&payload);
    creds.signature = ScVal::Map(Some(ScMap(vec![
        ScMapEntry { key: ScVal::Symbol("public_key".into()), val: ScVal::Bytes(keypair.public.to_bytes().to_vec().try_into().unwrap()) },
        ScMapEntry { key: ScVal::Symbol("signature".into()),  val: ScVal::Bytes(sig.to_bytes().to_vec().try_into().unwrap()) },
    ].try_into().unwrap())));
}`;
}

export function generateAuthSnapshots(
  authEntries: xdr.SorobanAuthorizationEntry[],
): AuthSnapshot[] {
  return authEntries.map((entry) => {
    const entryXdr = entry.toXDR('base64');
    const creds = entry.credentials();
    let signerAddress = 'source';
    let nonce: string | null = null;
    if (creds.switch().name === 'sorobanCredentialsAddress') {
      signerAddress = scAddressToString(creds.address().address());
      nonce = creds.address().nonce().toString();
    }
    const rootFn = entry.rootInvocation().function();
    let contractId = 'unknown',
      functionName = 'unknown';
    if (rootFn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
      contractId = StrKey.encodeContract(rootFn.contractFn().contractAddress().contractId());
      functionName = rootFn.contractFn().functionName().toString();
    }
    return {
      entryXdr,
      signerAddress,
      nonce,
      contractId,
      functionName,
      jsSnippet: buildJsSnippet(entryXdr, signerAddress, nonce, contractId, functionName),
      rustSnippet: buildRustSnippet(entryXdr, signerAddress, nonce, contractId, functionName),
    };
  });
}
