import { prismaWrite as prisma } from '../db';
import { uploadToS3 } from './s3Client';

// Transactions older than this many days have their rawXdr archived to S3
const RAW_XDR_RETENTION_DAYS = parseInt(process.env.RAW_XDR_RETENTION_DAYS ?? '90');
// How many rows to process per batch to avoid memory spikes
const ARCHIVE_BATCH_SIZE = parseInt(process.env.ARCHIVE_BATCH_SIZE ?? '500');

export interface ArchivalResult {
  archived: number;
  nullified: number;
  errors: number;
}

/**
 * Archive raw XDR from transactions older than RAW_XDR_RETENTION_DAYS to S3,
 * then null out the rawXdr column in the DB to reclaim space.
 *
 * S3 key format: xdr/{year}/{month}/{ledgerSequence}/{txHash}.json
 * The JSON payload contains rawXdr + enough metadata to reconstruct context.
 */
export async function archiveRawXdr(): Promise<ArchivalResult> {
  const cutoff = new Date(Date.now() - RAW_XDR_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result: ArchivalResult = { archived: 0, nullified: 0, errors: 0 };

  console.log(`[Archiver] Archiving rawXdr older than ${cutoff.toISOString()} to S3`);

  let cursor: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.transaction.findMany({
      where: {
        ledgerCloseTime: { lt: cutoff },
        rawXdr: { not: '' },
      },
      select: {
        id: true,
        hash: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
        contractAddress: true,
        rawXdr: true,
      },
      orderBy: { id: 'asc' },
      take: ARCHIVE_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const toNullify: string[] = [];

    await Promise.allSettled(
      rows.map(async (tx) => {
        const d = tx.ledgerCloseTime;
        const key = `xdr/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${tx.ledgerSequence}/${tx.hash}.json`;
        try {
          await uploadToS3(
            key,
            JSON.stringify({
              hash: tx.hash,
              ledgerSequence: tx.ledgerSequence,
              ledgerCloseTime: tx.ledgerCloseTime.toISOString(),
              contractAddress: tx.contractAddress,
              rawXdr: tx.rawXdr,
            }),
          );
          toNullify.push(tx.id);
          result.archived++;
        } catch (err) {
          console.error(`[Archiver] Failed to upload ${tx.hash}:`, err);
          result.errors++;
        }
      }),
    );

    if (toNullify.length > 0) {
      await prisma.transaction.updateMany({
        where: { id: { in: toNullify } },
        data: { rawXdr: '' },
      });
      result.nullified += toNullify.length;
    }
  }

  console.log(
    `[Archiver] Done — archived: ${result.archived}, nullified: ${result.nullified}, errors: ${result.errors}`,
  );
  return result;
}
