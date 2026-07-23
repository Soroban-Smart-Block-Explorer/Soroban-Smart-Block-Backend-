import { prismaRead, prismaWrite } from '../../db';

export interface IndexDocument {
  docType: string;
  docId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  docType: string;
  docId: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
}

export interface SearchOptions {
  query: string;
  docType?: string;
  docIds?: string[];
  limit?: number;
  offset?: number;
  sortBy?: 'relevance' | 'recent';
}

export async function indexDocument(doc: IndexDocument): Promise<void> {
  await prismaWrite.searchDocument.upsert({
    where: { docType_docId: { docType: doc.docType, docId: doc.docId } },
    create: {
      docType: doc.docType,
      docId: doc.docId,
      content: doc.content,
      metadata: (doc.metadata ?? {}) as object,
    },
    update: {
      content: doc.content,
      metadata: (doc.metadata ?? {}) as object,
    },
  });
}

export async function bulkIndexDocuments(docs: IndexDocument[]): Promise<void> {
  for (const doc of docs) {
    await indexDocument(doc);
  }
}

export async function searchDocuments(opts: SearchOptions): Promise<{
  results: SearchResult[];
  total: number;
}> {
  const { query, docType, limit = 50, offset = 0 } = opts;

  const where: Record<string, unknown> = {};
  if (docType) where.docType = docType;
  if (query) {
    where.content = { contains: query, mode: 'insensitive' };
  }

  const [results, total] = await Promise.all([
    prismaRead.searchDocument.findMany({
      where,
      select: { docType: true, docId: true, content: true, metadata: true },
      take: limit,
      skip: offset,
      orderBy: { updatedAt: 'desc' },
    }),
    prismaRead.searchDocument.count({ where }),
  ]);

  return {
    results: results.map((r) => ({
      docType: r.docType,
      docId: r.docId,
      content: r.content,
      metadata: r.metadata as Record<string, unknown> | null,
      score: 1,
    })),
    total,
  };
}

export async function fullTextSearch(
  query: string,
  docType?: string,
  limit = 50,
  offset = 0,
): Promise<{ results: SearchResult[]; total: number }> {
  const queryParam = query.replace(/'/g, "''");

  let sql = `
    SELECT "doc_type", "doc_id", "content", "metadata",
           ts_rank(to_tsvector('english', "content"), plainto_tsquery('english', $1)) AS "score"
    FROM "search_documents"
    WHERE to_tsvector('english', "content") @@ plainto_tsquery('english', $1)
  `;
  const params: string[] = [queryParam];

  if (docType) {
    sql += ` AND "doc_type" = $2`;
    params.push(docType);
  }

  const countSql = sql.replace(
    /SELECT "doc_type", "doc_id", "content", "metadata",[^F]+FROM/,
    'SELECT COUNT(*) FROM',
  );

  sql += ` ORDER BY "score" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(String(limit), String(offset));

  const [rows, countRows] = await Promise.all([
    prismaWrite.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params),
    prismaWrite.$queryRawUnsafe<Array<{ count: bigint }>>(countSql, ...params.slice(0, -2)),
  ]);

  const total = Number(countRows[0]?.count ?? 0);

  return {
    results: (
      rows as Array<{
        doc_type: string;
        doc_id: string;
        content: string;
        metadata: Record<string, unknown> | null;
        score: number;
      }>
    ).map((r) => ({
      docType: r.doc_type,
      docId: r.doc_id,
      content: r.content,
      metadata: r.metadata,
      score: Number(r.score),
    })),
    total,
  };
}

export async function deleteDocument(docType: string, docId: string): Promise<void> {
  try {
    await prismaWrite.searchDocument.delete({
      where: { docType_docId: { docType, docId } },
    });
  } catch {
    // ignore if not found
  }
}

export async function clearIndex(): Promise<void> {
  await prismaWrite.searchDocument.deleteMany({});
}
