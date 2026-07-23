import DataLoader from 'dataloader';
import { prismaRead as prisma } from '../db';

export function createLoaders() {
  const batchTransactionsByHash = new DataLoader<string, any>(async (hashes) => {
    const txs = await prisma.transaction.findMany({
      where: { hash: { in: [...hashes] } },
    });
    const map = new Map(txs.map((t) => [t.hash, t]));
    return hashes.map((h) => map.get(h) ?? null);
  });

  const batchEventsById = new DataLoader<string, any>(async (ids) => {
    const events = await prisma.event.findMany({
      where: { id: { in: [...ids] } },
    });
    const map = new Map(events.map((e) => [e.id, e]));
    return ids.map((id) => map.get(id) ?? null);
  });

  const batchContractsByAddress = new DataLoader<string, any>(async (addresses) => {
    const contracts = await prisma.contract.findMany({
      where: { address: { in: [...addresses] } },
    });
    const map = new Map(contracts.map((c) => [c.address, c]));
    return addresses.map((a) => map.get(a) ?? null);
  });

  const batchTransactionsByLedger = new DataLoader<number, any[]>(async (sequences) => {
    const txs = await prisma.transaction.findMany({
      where: { ledgerSequence: { in: [...sequences] } },
      orderBy: [{ ledgerSequence: 'desc' }, { id: 'desc' }],
    });
    const map = new Map<number, any[]>();
    for (const seq of sequences) map.set(seq, []);
    for (const tx of txs) map.get(tx.ledgerSequence)!.push(tx);
    return sequences.map((s) => map.get(s) ?? []);
  });

  const batchEventsByLedger = new DataLoader<number, any[]>(async (sequences) => {
    const events = await prisma.event.findMany({
      where: { ledgerSequence: { in: [...sequences] } },
      orderBy: { ledgerSequence: 'desc' },
    });
    const map = new Map<number, any[]>();
    for (const seq of sequences) map.set(seq, []);
    for (const ev of events) map.get(ev.ledgerSequence)!.push(ev);
    return sequences.map((s) => map.get(s) ?? []);
  });

  const batchEventsByTxHash = new DataLoader<string, any[]>(async (hashes) => {
    const events = await prisma.event.findMany({
      where: { transactionHash: { in: [...hashes] } },
      orderBy: { ledgerSequence: 'desc' },
    });
    const map = new Map<string, any[]>();
    for (const h of hashes) map.set(h, []);
    for (const ev of events) map.get(ev.transactionHash)!.push(ev);
    return hashes.map((h) => map.get(h) ?? []);
  });

  return {
    transactionByHash: batchTransactionsByHash,
    eventById: batchEventsById,
    contractByAddress: batchContractsByAddress,
    transactionsByLedger: batchTransactionsByLedger,
    eventsByLedger: batchEventsByLedger,
    eventsByTxHash: batchEventsByTxHash,
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
