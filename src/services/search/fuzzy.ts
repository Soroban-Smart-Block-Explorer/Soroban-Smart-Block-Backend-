import { prismaRead, prismaWrite } from '../../db';

const MIN_SIMILARITY = 0.3;
const TRIGRAM_MIN_LENGTH = 3;

export interface FuzzyMatchResult {
  docType: string;
  docId: string;
  similarity: number;
  content: string;
}

export function generateTrigrams(s: string): string[] {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const trigrams: string[] = [];
  for (let i = 0; i <= cleaned.length - 3; i++) {
    trigrams.push(cleaned.slice(i, i + 3));
  }
  return trigrams;
}

export function generateNgrams(s: string, n: number): string[] {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ngrams: string[] = [];
  for (let i = 0; i <= cleaned.length - n; i++) {
    ngrams.push(cleaned.slice(i, i + n));
  }
  return ngrams;
}

export async function indexNGrams(docType: string, docId: string, text: string): Promise<void> {
  const trigrams = generateTrigrams(text);

  const values = trigrams.map((gram, i) => ({
    docType,
    docId,
    gram,
    position: i,
  }));

  const existing = await prismaRead.searchNGram.findMany({
    where: { docType, docId },
    select: { id: true },
  });

  if (existing.length > 0) {
    await prismaWrite.searchNGram.deleteMany({ where: { docType, docId } });
  }

  if (values.length > 0) {
    await prismaWrite.searchNGram.createMany({ data: values });
  }
}

export async function fuzzySearch(
  query: string,
  docType?: string,
  limit = 20,
): Promise<FuzzyMatchResult[]> {
  if (query.length < TRIGRAM_MIN_LENGTH) {
    return [];
  }

  const queryParam = query.replace(/'/g, "''");

  let sql = `
    SELECT DISTINCT sd."doc_type", sd."doc_id", sd."content",
           similarity(sd."content", $1) AS "sim"
    FROM "search_documents" sd
    WHERE sd."content" % $1
  `;
  const params: string[] = [queryParam];

  if (docType) {
    sql += ` AND sd."doc_type" = $2`;
    params.push(docType);
  }

  sql += ` ORDER BY "sim" DESC LIMIT $${params.length + 1}`;
  params.push(String(limit));

  const rows = await prismaWrite.$queryRawUnsafe<
    Array<{ doc_type: string; doc_id: string; content: string; sim: number }>
  >(sql, ...params);

  return rows
    .filter((r) => r.sim >= MIN_SIMILARITY)
    .map((r) => ({
      docType: r.doc_type,
      docId: r.doc_id,
      similarity: Number(r.sim),
      content: r.content,
    }));
}

export async function fuzzySearchAddress(query: string, limit = 10): Promise<FuzzyMatchResult[]> {
  return fuzzySearch(query, undefined, limit);
}

export function normalizeStellarAddress(address: string): string {
  const cleaned = address.replace(/[^GBCDA-Z0-9]/g, '');
  return cleaned;
}

export function levenshteinDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= an; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bn; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[an][bn];
}
