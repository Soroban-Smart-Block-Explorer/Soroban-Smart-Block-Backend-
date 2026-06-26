import { prisma } from '../db';
import { decodeScValXdr } from './scval-decoder';

export type StateOperation = 'create' | 'update' | 'delete';

export interface StateChangeRecord {
  contractAddress: string;
  ledger: number;
  ledgerCloseTime: Date;
  storageKey: string;
  storageKeyHuman?: string;
  valueBefore?: string;
  valueAfter?: string;
  valueHuman?: string;
  operation: StateOperation;
  transactionHash?: string;
}

function safeDecodeXdr(base64: string): string {
  return decodeScValXdr(base64);
}

// Placeholder: used by future ledger-entry polling
async function fetchLedgerEntries(_contractAddress: string): Promise<
  { key: string; value: string }[]
> {
  return [];
}

export async function captureStateChange(record: StateChangeRecord): Promise<void> {
  await prisma.contractStateChange.create({
    data: {
      contractAddress: record.contractAddress,
      ledger: record.ledger,
      ledgerCloseTime: record.ledgerCloseTime,
      storageKey: record.storageKey,
      storageKeyHuman: record.storageKeyHuman,
      valueBefore: record.valueBefore,
      valueAfter: record.valueAfter,
      valueHuman: record.valueHuman,
      operation: record.operation,
      transactionHash: record.transactionHash,
    },
  });
}

export async function captureStateChangesForTransaction(
  contractAddress: string,
  transactionHash: string,
  ledger: number,
  ledgerCloseTime: Date,
  stateChanges: Array<{
    key: string;
    before?: string;
    after?: string;
  }>,
): Promise<number> {
  let saved = 0;
  for (const change of stateChanges) {
    const operation: StateOperation =
      !change.before ? 'create' : !change.after ? 'delete' : 'update';

    const keyHuman = change.key ? safeDecodeXdr(change.key) : undefined;
    const valueHuman = change.after ? safeDecodeXdr(change.after) : undefined;

    await captureStateChange({
      contractAddress,
      ledger,
      ledgerCloseTime,
      storageKey: change.key,
      storageKeyHuman: keyHuman,
      valueBefore: change.before,
      valueAfter: change.after,
      valueHuman,
      operation,
      transactionHash,
    });
    saved++;
  }
  return saved;
}
