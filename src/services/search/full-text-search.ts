/**
 * SR01 — Unified full-text search.
 *
 * Backs `GET /api/v1/search?q=&type=` with ranked, highlighted matches over
 * the contracts, decoded events and transaction metadata held in the
 * `_search_documents` inverted index (see docs/search-design.md §2.2/§3).
 *
 * The index is a single Postgres table whose `search_vector` column is a
 * generated `tsvector`, so ranking (`ts_rank`) and snippet highlighting
 * (`ts_headline`) are pushed down to the database and served from a GIN index.
 * Rows are maintained incrementally by the indexer; `rebuildSearchIndex`
 * re-hydrates the whole index from the primary tables.
 */
import { randomUUID } from 'crypto';
import { prismaRead, prismaWrite } from '../../db';
import { logger } from '../../logger';

export type SearchDocType = 'contract' | 'event' | 'transaction';

export const SEARCH_DOC_TYPES: readonly SearchDocType[] = ['contract', 'event', 'transaction'];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Cap on how much of a single JSON field is folded into a document. */
const MAX_FIELD_CHARS = 4000;

// ── Shapes accepted by the indexers ─────────────────────────────────────────

export interface TransactionSearchFields {
  id?: string | null;
  hash?: string | null;
  sourceAccount?: string | null;
  contractAddress?: string | null;
  functionName?: string | null;
  functionArgs?: unknown;
  humanReadable?: string | null;
  status?: string | null;
  ledgerSequence?: number | null;
}

export interface EventSearchFields {
  id?: string | null;
  transactionHash?: string | null;
  contractAddress?: string | null;
  eventType?: string | null;
  topicSymbol?: string | null;
  topics?: unknown;
  decoded?: unknown;
  ledgerSequence?: number | null;
}

export interface ContractSearchFields {
  id?: string | null;
  address?: string | null;
  name?: string | null;
  description?: string | null;
  tokenSymbol?: string | null;
  functionSignatures?: unknown;
  wasmHash?: string | null;
  isToken?: boolean | null;
}

export interface SearchDocumentInput {
  docType: SearchDocType;
  docId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  docType: string;
  docId: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
  highlight: string;
}

export interface SearchResultPage {
  query: string;
  type: string;
  total: number;
  limit: number;
  offset: number;
  results: SearchHit[];
}

export interface SearchQueryOptions {
  q: string;
  type?: SearchDocType | 'all' | string;
  limit?: number;
  offset?: number;
  highlight?: boolean;
}

// ── Content builders ────────────────────────────────────────────────────────

function toText(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (!text || text === '{}' || text === '[]' || text === 'null') return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function joinParts(parts: Array<string | undefined | null>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ');
}

export function buildTransactionContent(tx: TransactionSearchFields): string {
  return joinParts([
    tx.hash,
    tx.sourceAccount,
    tx.contractAddress,
    tx.functionName,
    tx.humanReadable,
    tx.status,
    toText(tx.functionArgs),
  ]);
}

export function buildEventContent(event: EventSearchFields): string {
  return joinParts([
    event.contractAddress,
    event.eventType,
    event.topicSymbol,
    event.transactionHash,
    toText(event.decoded),
    toText(event.topics),
  ]);
}

export function buildContractContent(contract: ContractSearchFields): string {
  const signatures = Array.isArray(contract.functionSignatures)
    ? contract.functionSignatures.filter((s): s is string => typeof s === 'string').join(' ')
    : toText(contract.functionSignatures);

  return joinParts([
    contract.address,
    contract.name,
    contract.description,
    contract.tokenSymbol,
    signatures,
    contract.wasmHash,
  ]);
}

// ── Indexing ────────────────────────────────────────────────────────────────

/**
 * Upsert one document into the inverted index. Idempotent on (docType, docId)
 * so the indexer can safely re-run a ledger after a reorg/retry.
 */
export async function indexSearchDocument(doc: SearchDocumentInput): Promise<void> {
  const metadata = (doc.metadata ?? {}) as object;
  await prismaWrite.searchDocument.upsert({
    where: { docType_docId: { docType: doc.docType, docId: doc.docId } },
    create: {
      id: randomUUID(),
      docType: doc.docType,
      docId: doc.docId,
      content: doc.content,
      metadata,
    },
    update: { content: doc.content, metadata },
  });
}

export async function indexTransaction(tx: TransactionSearchFields): Promise<void> {
  const docId = tx.id ?? tx.hash;
  if (!docId) return;
  await indexSearchDocument({
    docType: 'transaction',
    docId,
    content: buildTransactionContent(tx),
    metadata: {
      hash: tx.hash ?? null,
      sourceAccount: tx.sourceAccount ?? null,
      contractAddress: tx.contractAddress ?? null,
      functionName: tx.functionName ?? null,
      status: tx.status ?? null,
      ledgerSequence: tx.ledgerSequence ?? null,
    },
  });
}

export async function indexEvent(event: EventSearchFields): Promise<void> {
  if (!event.id) return;
  await indexSearchDocument({
    docType: 'event',
    docId: event.id,
    content: buildEventContent(event),
    metadata: {
      transactionHash: event.transactionHash ?? null,
      contractAddress: event.contractAddress ?? null,
      eventType: event.eventType ?? null,
      topicSymbol: event.topicSymbol ?? null,
      ledgerSequence: event.ledgerSequence ?? null,
    },
  });
}

export async function indexContract(contract: ContractSearchFields): Promise<void> {
  const docId = contract.address ?? contract.id;
  if (!docId) return;
  await indexSearchDocument({
    docType: 'contract',
    docId,
    content: buildContractContent(contract),
    metadata: {
      address: contract.address ?? null,
      name: contract.name ?? null,
      tokenSymbol: contract.tokenSymbol ?? null,
      isToken: contract.isToken ?? null,
    },
  });
}

/**
 * Best-effort indexing used by the indexer hot path: a search-index failure
 * must never abort ledger ingestion, so errors are logged and swallowed.
 */
export async function indexSafely(label: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    logger.warn(`search index update failed (${label})`, { error: String(err) });
  }
}

// ── Querying ────────────────────────────────────────────────────────────────

interface SearchRow {
  doc_type: string;
  doc_id: string;
  content: string;
  metadata: unknown;
  score: number;
  highlight: string | null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function normalizeType(type?: string): SearchDocType | undefined {
  if (!type || type === 'all') return undefined;
  return (SEARCH_DOC_TYPES as readonly string[]).includes(type)
    ? (type as SearchDocType)
    : undefined;
}

/**
 * Ranked full-text search. `websearch_to_tsquery` is used rather than
 * `to_tsquery` because it accepts arbitrary user input (quotes, `or`, `-`)
 * without throwing on syntax errors. Both the query text and the type filter
 * are passed as bound parameters — never interpolated — so the query is
 * injection-safe.
 */
export async function searchFullText(opts: SearchQueryOptions): Promise<SearchResultPage> {
  const q = (opts.q ?? '').trim();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const type = normalizeType(opts.type);
  const typeLabel = opts.type && opts.type !== 'all' ? String(opts.type) : 'all';
  const highlight = opts.highlight !== false;

  if (!q) {
    return { query: q, type: typeLabel, total: 0, limit, offset, results: [] };
  }

  const filterParams: unknown[] = [q];
  let where = `"search_vector" @@ websearch_to_tsquery('english', $1)`;
  if (type) {
    filterParams.push(type);
    where += ` AND "doc_type" = $${filterParams.length}`;
  }

  const highlightSelect = highlight
    ? `, ts_headline('english', "content", websearch_to_tsquery('english', $1), ` +
      `'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, ShortWord=3, HighlightAll=false') AS "highlight"`
    : `, ''::text AS "highlight"`;

  const listSql =
    `SELECT "doc_type", "doc_id", "content", "metadata", ` +
    `ts_rank("search_vector", websearch_to_tsquery('english', $1)) AS "score"${highlightSelect} ` +
    `FROM "_search_documents" WHERE ${where} ` +
    `ORDER BY "score" DESC, "updated_at" DESC ` +
    `LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`;

  const countSql = `SELECT COUNT(*)::int AS "count" FROM "_search_documents" WHERE ${where}`;

  const [rows, countRows] = await Promise.all([
    prismaRead.$queryRawUnsafe<SearchRow[]>(listSql, ...filterParams, limit, offset),
    prismaRead.$queryRawUnsafe<Array<{ count: number }>>(countSql, ...filterParams),
  ]);

  return {
    query: q,
    type: typeLabel,
    total: Number(countRows?.[0]?.count ?? 0),
    limit,
    offset,
    results: (rows ?? []).map((row) => ({
      docType: row.doc_type,
      docId: row.doc_id,
      content: row.content,
      metadata: toRecord(row.metadata),
      score: Number(row.score ?? 0),
      highlight: row.highlight ?? row.content,
    })),
  };
}

// ── Full rebuild ────────────────────────────────────────────────────────────

async function paginate<T extends { id: string }>(
  fetch: (cursor?: string) => Promise<T[]>,
  handle: (rows: T[]) => Promise<void>,
  batchSize: number,
): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const rows = await fetch(cursor);
    if (rows.length === 0) break;
    await handle(rows);
    count += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }
  return count;
}

/**
 * Rebuild the entire search index from the primary tables. Used to bootstrap
 * search on an existing database and to recover from index corruption. The
 * delete + re-insert is not atomic; concurrent queries may briefly miss rows.
 */
export async function rebuildSearchIndex(batchSize = 1000): Promise<{ indexed: number }> {
  await prismaWrite.searchDocument.deleteMany({});

  let indexed = 0;

  indexed += await paginate(
    (cursor) =>
      prismaRead.transaction.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          hash: true,
          sourceAccount: true,
          contractAddress: true,
          functionName: true,
          functionArgs: true,
          humanReadable: true,
          status: true,
          ledgerSequence: true,
        },
      }),
    async (rows) => {
      for (const row of rows) await indexTransaction(row);
    },
    batchSize,
  );

  indexed += await paginate(
    (cursor) =>
      prismaRead.event.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          transactionHash: true,
          contractAddress: true,
          eventType: true,
          topicSymbol: true,
          topics: true,
          decoded: true,
          ledgerSequence: true,
        },
      }),
    async (rows) => {
      for (const row of rows) await indexEvent(row);
    },
    batchSize,
  );

  indexed += await paginate(
    (cursor) =>
      prismaRead.contract.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          address: true,
          name: true,
          description: true,
          tokenSymbol: true,
          functionSignatures: true,
          wasmHash: true,
          isToken: true,
        },
      }),
    async (rows) => {
      for (const row of rows) await indexContract(row);
    },
    batchSize,
  );

  logger.info('search index rebuilt', { indexed });
  return { indexed };
}
