import {
  TransactionBuilder,
  SorobanRpc,
  Contract,
  Account,
  Operation,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { rpc } from '../indexer/rpc';
import { config } from '../config';
import { encodeScVal, ScValInput, decodeScVal } from './scval-codec';

// suppress unused import warning
void Operation;

export interface ReadRequest {
  functionName: string;
  args: ScValInput[];
  sourceAccount?: string;
}

export interface ReadResult {
  functionName: string;
  result: unknown;
  resultXdr: string;
  success: boolean;
  error?: string;
}

export interface BuildTxRequest {
  functionName: string;
  args: ScValInput[];
  sourceAccount: string;
  fee?: string;
}

export interface BuildTxResult {
  functionName: string;
  unsignedXdr: string;
  simulationSuccess: boolean;
  simulationResult?: unknown;
  estimatedFee?: string;
  estimatedResources?: {
    cpuInstructions: number;
    memory: number;
    ledgerReads: number;
    ledgerWrites: number;
  };
  error?: string;
}

const LEDGER_VALID = 60;

function getNetworkPassphrase(): string {
  return config.networkPassphrase;
}

async function buildTransaction(
  contractAddress: string,
  functionName: string,
  args: xdr.ScVal[],
  account: Account,
) {
  const c = new Contract(contractAddress);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(c.call(functionName, ...args))
    .setTimeout(LEDGER_VALID)
    .build();
}

export async function readContract(
  contractAddress: string,
  req: ReadRequest,
): Promise<ReadResult> {
  let encodedArgs: xdr.ScVal[];
  try {
    encodedArgs = req.args.map(encodeScVal);
  } catch (e) {
    return { functionName: req.functionName, result: null, resultXdr: '', success: false, error: String(e) };
  }

  try {
    const sourceKey = req.sourceAccount ?? 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    const account = await rpc.getAccount(sourceKey);
    const tx = await buildTransaction(contractAddress, req.functionName, encodedArgs, account);
    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return { functionName: req.functionName, result: null, resultXdr: '', success: false, error: simResult.error };
    }

    const retval: xdr.ScVal | undefined = (simResult as any).result?.retval;
    const resultXdr = retval ? retval.toXDR('base64') : '';
    const decoded = retval ? decodeScVal(retval) : null;
    return { functionName: req.functionName, result: decoded, resultXdr, success: true };
  } catch (e) {
    return { functionName: req.functionName, result: null, resultXdr: '', success: false, error: String(e) };
  }
}

export async function buildSignableTransaction(
  contractAddress: string,
  req: BuildTxRequest,
): Promise<BuildTxResult> {
  let encodedArgs: xdr.ScVal[];
  try {
    encodedArgs = req.args.map(encodeScVal);
  } catch (e) {
    return { functionName: req.functionName, unsignedXdr: '', simulationSuccess: false, error: String(e) };
  }

  try {
    const account = await rpc.getAccount(req.sourceAccount);
    const tx = await buildTransaction(contractAddress, req.functionName, encodedArgs, account);
    const simResult = await rpc.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return { functionName: req.functionName, unsignedXdr: '', simulationSuccess: false, error: simResult.error };
    }

    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();
    const unsignedXdr = assembled.toXDR();

    const resources = (simResult as any).transactionData?.resources?.();
    const estimatedResources = resources
      ? {
          cpuInstructions: Number(resources.instructions ?? 0),
          memory: Number(resources.readBytes ?? 0),
          ledgerReads: Number(resources.readEntries ?? 0),
          ledgerWrites: Number(resources.writeEntries ?? 0),
        }
      : undefined;

    const minFee = (simResult as any).minResourceFee;
    const retval: xdr.ScVal | undefined = (simResult as any).result?.retval;
    const simulationResult = retval ? decodeScVal(retval) : null;

    return {
      functionName: req.functionName,
      unsignedXdr,
      simulationSuccess: true,
      simulationResult,
      estimatedFee: minFee != null ? String(minFee) : undefined,
      estimatedResources,
    };
  } catch (e) {
    return { functionName: req.functionName, unsignedXdr: '', simulationSuccess: false, error: String(e) };
  }
}

export interface SubmitRequest {
  signedXdr: string;
}

export interface SubmitResult {
  hash: string;
  status: string;
  error?: string;
}

export async function submitTransaction(req: SubmitRequest): Promise<SubmitResult> {
  try {
    const tx = TransactionBuilder.fromXDR(req.signedXdr, getNetworkPassphrase());
    const response = await rpc.sendTransaction(tx);
    return { hash: response.hash, status: response.status };
  } catch (e) {
    return { hash: '', status: 'error', error: String(e) };
  }
}
