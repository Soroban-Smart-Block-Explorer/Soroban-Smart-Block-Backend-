import { prismaRead, prismaWrite } from '../../db';
import { indexDocument, clearIndex } from './inverted-index';
import { indexNGrams } from './fuzzy';
import { indexSuggestion, clearSuggestions } from './autocomplete';
import { clearEmbeddings } from './semantic';

export async function rebuildAllIndexes(): Promise<void> {
  await prismaWrite.searchIndexState.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      status: 'rebuilding',
      startedAt: new Date(),
    },
    update: {
      status: 'rebuilding',
      startedAt: new Date(),
      completedAt: null,
      error: null,
      progress: 0,
    },
  });

  try {
    await clearIndex();
    await prismaWrite.searchNGram.deleteMany({});
    await clearSuggestions();
    await clearEmbeddings();

    const [txCount, contractCount] = await Promise.all([
      prismaRead.transaction.count(),
      prismaRead.contract.count(),
    ]);

    const totalDocs = txCount + contractCount;
    let indexed = 0;

    await prismaWrite.searchIndexState.update({
      where: { id: 'singleton' },
      data: { totalDocs, indexedDocs: 0, progress: 0 },
    });

    const BATCH = 1000;
    let cursor: { id: string } | undefined;

    for (;;) {
      const txs = await prismaRead.transaction.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor.id } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          hash: true,
          sourceAccount: true,
          contractAddress: true,
          functionName: true,
          humanReadable: true,
          status: true,
          feeCharged: true,
        },
      });

      if (txs.length === 0) break;

      for (const tx of txs) {
        const content = [
          tx.hash,
          tx.sourceAccount,
          tx.contractAddress,
          tx.functionName,
          tx.humanReadable,
          tx.status,
        ]
          .filter(Boolean)
          .join(' ');

        await indexDocument({
          docType: 'transaction',
          docId: tx.id,
          content,
          metadata: {
            hash: tx.hash,
            sourceAccount: tx.sourceAccount,
            contractAddress: tx.contractAddress,
            functionName: tx.functionName,
            status: tx.status,
            feeCharged: tx.feeCharged,
          },
        });

        await indexNGrams('transaction', tx.id, tx.hash);
        await indexSuggestion('transaction', tx.id, tx.hash);
      }

      indexed += txs.length;
      await prismaWrite.searchIndexState.update({
        where: { id: 'singleton' },
        data: { indexedDocs: indexed, progress: indexed / totalDocs },
      });

      cursor = { id: txs[txs.length - 1].id };
    }

    cursor = undefined;
    for (;;) {
      interface ContractRow {
        id: string;
        address: string;
        name: string | null;
        description: string | null;
        functionSignatures: unknown;
        isToken: boolean;
        tokenSymbol: string | null;
        wasmHash: string | null;
        isVerified: boolean;
      }
      const contractRows: ContractRow[] = await prismaRead.contract.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor.id } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          address: true,
          name: true,
          description: true,
          functionSignatures: true,
          isToken: true,
          tokenSymbol: true,
          wasmHash: true,
          isVerified: true,
        },
      });

      if (contractRows.length === 0) break;

      for (const c of contractRows) {
        const sigs = Array.isArray(c.functionSignatures)
          ? (c.functionSignatures as string[]).join(' ')
          : '';
        const content = [c.address, c.name, c.description, sigs, c.tokenSymbol]
          .filter(Boolean)
          .join(' ');

        await indexDocument({
          docType: 'contract',
          docId: c.id,
          content,
          metadata: {
            address: c.address,
            name: c.name,
            isToken: c.isToken,
            tokenSymbol: c.tokenSymbol,
            wasmHash: c.wasmHash,
            isVerified: c.isVerified,
          },
        });

        await indexNGrams('contract', c.id, c.address);
        if (c.name) {
          await indexSuggestion('contract', c.id, c.name);
          await indexSuggestion('contract', c.id, c.address);
        }
      }

      indexed += contractRows.length;
      await prismaWrite.searchIndexState.update({
        where: { id: 'singleton' },
        data: { indexedDocs: indexed, progress: indexed / totalDocs },
      });

      cursor = { id: contractRows[contractRows.length - 1].id };
    }

    await prismaWrite.searchIndexState.update({
      where: { id: 'singleton' },
      data: {
        status: 'completed',
        completedAt: new Date(),
        progress: 1,
        indexedDocs: indexed,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await prismaWrite.searchIndexState.update({
      where: { id: 'singleton' },
      data: { status: 'failed', error: msg },
    });
    throw err;
  }
}

export async function getIndexStatus(): Promise<{
  status: string;
  progress: number;
  totalDocs: number;
  indexedDocs: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}> {
  const state = await prismaRead.searchIndexState.findUnique({
    where: { id: 'singleton' },
  });

  if (!state) {
    return {
      status: 'idle',
      progress: 0,
      totalDocs: 0,
      indexedDocs: 0,
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }

  return {
    status: state.status,
    progress: state.progress,
    totalDocs: state.totalDocs,
    indexedDocs: state.indexedDocs,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error,
  };
}
