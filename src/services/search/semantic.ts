import { prismaWrite } from '../../db';

export interface SemanticSearchResult {
  contractAddress?: string;
  txHash?: string;
  eventId?: string;
  similarity: number;
  contentText?: string;
}

export async function searchSimilarContracts(
  embedding: number[],
  modelName = 'codebert',
  limit = 20,
  threshold = 0.7,
): Promise<SemanticSearchResult[]> {
  const embeddingStr = `[${embedding.join(',')}]`;

  const sql = `
    SELECT "contract_address", "source_type", "content_hash",
           1 - ("embedding" <=> $1::vector) AS "similarity"
    FROM "contract_embeddings"
    WHERE "model_name" = $2
      AND 1 - ("embedding" <=> $1::vector) >= $3
    ORDER BY "similarity" DESC
    LIMIT $4
  `;

  const rows = await prismaWrite.$queryRawUnsafe<
    Array<{
      contract_address: string;
      source_type: string;
      content_hash: string;
      similarity: number;
    }>
  >(sql, embeddingStr, modelName, threshold, limit);

  return rows.map((r) => ({
    contractAddress: r.contract_address,
    similarity: Number(r.similarity),
    contentText: r.source_type,
  }));
}

export async function searchSimilarTransactions(
  embedding: number[],
  limit = 20,
  threshold = 0.5,
): Promise<SemanticSearchResult[]> {
  const embeddingStr = `[${embedding.join(',')}]`;

  const sql = `
    SELECT "tx_hash", "content_text",
           1 - ("embedding" <=> $1::vector) AS "similarity"
    FROM "tx_embeddings"
    WHERE 1 - ("embedding" <=> $1::vector) >= $2
    ORDER BY "similarity" DESC
    LIMIT $3
  `;

  const rows = await prismaWrite.$queryRawUnsafe<
    Array<{ tx_hash: string; content_text: string; similarity: number }>
  >(sql, embeddingStr, threshold, limit);

  return rows.map((r) => ({
    txHash: r.tx_hash,
    similarity: Number(r.similarity),
    contentText: r.content_text,
  }));
}

export async function searchSimilarEvents(
  embedding: number[],
  limit = 20,
  threshold = 0.5,
): Promise<SemanticSearchResult[]> {
  const embeddingStr = `[${embedding.join(',')}]`;

  const sql = `
    SELECT "event_id", "param_types",
           1 - ("embedding" <=> $1::vector) AS "similarity"
    FROM "event_embeddings"
    WHERE 1 - ("embedding" <=> $1::vector) >= $2
    ORDER BY "similarity" DESC
    LIMIT $3
  `;

  const rows = await prismaWrite.$queryRawUnsafe<
    Array<{ event_id: string; param_types: string; similarity: number }>
  >(sql, embeddingStr, threshold, limit);

  return rows.map((r) => ({
    eventId: r.event_id,
    similarity: Number(r.similarity),
    contentText: r.param_types,
  }));
}

export async function storeContractEmbedding(
  contractAddress: string,
  embedding: number[],
  modelName = 'codebert',
  sourceType = 'code',
  contentHash?: string,
): Promise<void> {
  const embeddingStr = `[${embedding.join(',')}]`;

  await prismaWrite.$executeRawUnsafe(
    `INSERT INTO "contract_embeddings" ("id", "contract_address", "model_name", "embedding", "source_type", "content_hash")
     VALUES ($1, $2, $3, $4::vector, $5, $6)
     ON CONFLICT ("id") DO UPDATE SET "embedding" = $4::vector, "updated_at" = NOW()`,
    `${contractAddress}-${modelName}-${sourceType}`,
    contractAddress,
    modelName,
    embeddingStr,
    sourceType,
    contentHash ?? null,
  );
}

export async function storeTxEmbedding(
  txHash: string,
  embedding: number[],
  contentText?: string,
): Promise<void> {
  const embeddingStr = `[${embedding.join(',')}]`;

  await prismaWrite.$executeRawUnsafe(
    `INSERT INTO "tx_embeddings" ("id", "tx_hash", "embedding", "content_text")
     VALUES ($1, $2, $3::vector, $4)
     ON CONFLICT ("id") DO UPDATE SET "embedding" = $3::vector`,
    txHash,
    txHash,
    embeddingStr,
    contentText ?? null,
  );
}

export async function deleteContractEmbeddings(
  contractAddress: string,
  modelName?: string,
): Promise<void> {
  if (modelName) {
    await prismaWrite.$executeRawUnsafe(
      `DELETE FROM "contract_embeddings" WHERE "contract_address" = $1 AND "model_name" = $2`,
      contractAddress,
      modelName,
    );
  } else {
    await prismaWrite.$executeRawUnsafe(
      `DELETE FROM "contract_embeddings" WHERE "contract_address" = $1`,
      contractAddress,
    );
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function hybridScore(cosineSim: number, bm25Score: number, alpha = 0.7): number {
  return alpha * cosineSim + (1 - alpha) * bm25Score;
}

export async function clearEmbeddings(): Promise<void> {
  await prismaWrite.$executeRawUnsafe(`TRUNCATE "contract_embeddings"`);
  await prismaWrite.$executeRawUnsafe(`TRUNCATE "tx_embeddings"`);
  await prismaWrite.$executeRawUnsafe(`TRUNCATE "event_embeddings"`);
}
