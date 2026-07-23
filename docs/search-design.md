# Search System Design Document

## 1. Architecture Overview

The search system is built as a multi-layered engine on PostgreSQL, using extensions for advanced features:

```
┌─────────────────────────────────────────────────────────────┐
│                    API Layer (Express)                       │
│  /api/v1/search/*  |  /api/v1/query/*  |  /api/v1/suggest*  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   Service Layer                              │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Inverted   │ │ Fuzzy /  │ │ Semantic │ │ NLQ Engine  │  │
│  │ Index      │ │ N-gram   │ │ (Vector) │ │ (LLM-based) │  │
│  │ Engine     │ │ Matcher  │ │ Search   │ │             │  │
│  └────────────┘ └──────────┘ └──────────┘ └─────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│               PostgreSQL (with extensions)                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ pg_trgm  │ │ pgvector │ │ Full-text│ │ Inverted      │  │
│  │ (fuzzy)  │ │(embeds)  │ │ (tsvector)│ │ Index Tables │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 2. Database Layer

### 2.1 PostgreSQL Extensions

| Extension | Purpose | Version |
|-----------|---------|---------|
| `pg_trgm` | Trigram fuzzy matching, prefix autocomplete | bundled |
| `pgvector` | Dense vector storage and cosine similarity | 0.7+ |
| `btree_gin` | Generalized inverted index for full-text | bundled |

### 2.2 Index Tables

**SearchDocument** — Unified inverted index entry
- `id`, `docType` (transaction|contract|wallet|event), `docId` (FK to source), `content` (text), `tokens` (tsvector), `metadata` (jsonb)
- GIN index on `tokens`
- BTREE on `docType`
- Trigram GIN index on `content` for fuzzy search

**SearchNGram** — N-gram index for typo-tolerant search
- `id`, `docType`, `docId`, `gram` (text), `position` (int)
- BTREE on `gram`
- Used for edit-distance based matching

**ContractEmbedding** — Dense vector for semantic contract search
- `id`, `contractAddress`, `modelName`, `embedding` (vector(768)), `contentHash`, `sourceType` (code|abi|readme)
- IVFFlat index on embedding

**TxEmbedding** — Dense vector for transaction semantic search
- `id`, `txHash`, `embedding` (vector(384)), `contentText`
- IVFFlat index on embedding

### 2.3 Search Freshness

Index freshness is achieved via:
1. **Real-time indexing**: The indexer writes to search tables synchronously after each ledger is processed
2. **Background batch refresh**: A scheduled job re-syncs search indexes every 30s for missed records
3. **Materialized view refresh**: Aggregated search views refresh every 60s

Target: new transactions searchable within 5s of indexing (p99).

### 2.4 Index Rebuild Performance

Index rebuild from scratch uses:
- Batch INSERT with `UNNEST` (10k records per batch)
- Parallel workers (configurable, default 4)
- `SET maintenance_work_mem = '2GB'`
- Estimated time for 100M documents: < 2 hours

## 3. Search Capabilities

### 3.1 Transaction Search

Filters: `sender`, `receiver`, `contract`, `amountMin`, `amountMax`, `dateFrom`, `dateTo`, `eventType`, `memoContent`, `status`, `token`, `sort`, `limit`, `offset`

### 3.2 Contract Search

Filters: `name`, `functionSignatures` (4-byte selectors), `wasmHash`, `sourceCode`, `compiler`, `isVerified`, `isToken`, `tokenSymbol`

### 3.3 Wallet Search

Filters: `address`, `ensName`, `stellarName`, `txCountMin`, `txCountMax`, `balanceMin`, `balanceMax`, `createdAfter`, `createdBefore`

### 3.4 Event Search

Filters: `eventType`, `contract`, `paramValues`, `timestampFrom`, `timestampTo`, `topicSymbol`

### 3.5 Fuzzy Search

- Trigram similarity (`pg_trgm.similarity()`) for typo-tolerant address matching
- Threshold: > 0.3 similarity for address candidates
- N-gram index for "Stelar" → "Stellar" with 95%+ accuracy
- Edit distance < 3 for high-confidence matches

### 3.6 Autocomplete

- Prefix matching via `LIKE 'prefix%'` on trigram-indexed column
- Suffix matching via reverse-string trigram index
- Returns top-10 suggestions sorted by popularity (usage count)

## 4. Semantic Search

### 4.1 Embedding Model Comparison

| Model | Dimensions | Use Case | Quality | Speed | Size |
|-------|-----------|----------|---------|-------|------|
| **CodeBERT** | 768 | Contract source code | ★★★★★ | ★★★ | ~500MB |
| **CodeLlama-7B** | 4096 | General code | ★★★★★ | ★★ | ~13GB |
| **Sentence-BERT (all-MiniLM-L6-v2)** | 384 | Transaction memos, text | ★★★★ | ★★★★★ | ~80MB |
| **OpenAI text-embedding-3-small** | 1536 | General text | ★★★★★ | ★★★★ | API |
| **OpenAI text-embedding-3-large** | 3072 | High-accuracy | ★★★★★ | ★★★ | API |

**Recommendation:**
- **Contract embeddings**: CodeBERT (768-dim) — best quality/speed tradeoff for code
- **Transaction/text embeddings**: Sentence-BERT all-MiniLM-L6-v2 (384-dim) — fastest, good quality
- **Fallback**: OpenAI text-embedding-3-small via API when local models unavailable

### 4.2 Similarity Search

- Cosine similarity via `pgvector` `<=>` operator
- Hybrid search: `alpha * cosine_sim + (1-alpha) * BM25_score`
- Configurable alpha (default: 0.7 for code, 0.5 for text)
- IVFFlat index with `lists = sqrt(n) * 2` for 100k+ embeddings

### 4.3 Performance Targets

- Full-text search on 1B+ transactions: < 100ms p99
- Semantic search over 100k embeddings: < 200ms p99
- Hybrid search: < 300ms p99

## 5. Natural Language Query Engine

### 5.1 Architecture

```
User Query → Language Detection → Intent Classification
    → Entity Extraction → LLM Translation → Query Validation
    → SQL/API Query Generation → Execution → Result → Explanation
                    ↕
           Conversation Memory
           (session context)
```

### 5.2 LLM Integration

The NLQ engine integrates with LLMs for NL→SQL translation:

1. **Prompt Construction**: Schema context + user query + conversation history
2. **Schema-Aware**: LLM receives a sanitized schema (table names, columns, types) to prevent hallucinated fields
3. **Query Validation**: Generated SQL is validated against the actual Prisma schema using regex-based field whitelisting
4. **Explanation Generation**: SQL is translated back to English using a structured explanation template

### 5.3 Multi-Turn Refinement

- Session context maintains `activeFilters`, `resolvedEntities`, and `queryHistory`
- Follow-up queries merge with existing context
- Example: "show me whale transactions" → "only from the past 24 hours" → "and greater than 10k XLM"

### 5.4 Accuracy Targets

- 90%+ correct on 500-query test suite
- False positives < 5%
- Translation time < 2s

## 6. API Endpoints

### 6.1 Search Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/search/transactions` | Transaction search with filters |
| GET | `/api/v1/search/contracts` | Contract search with filters |
| GET | `/api/v1/search/wallets` | Wallet search with filters |
| GET | `/api/v1/search/events` | Event search with filters |
| GET | `/api/v1/search/fuzzy` | Fuzzy search across all types |
| GET | `/api/v1/search/semantic` | Semantic similarity search |
| GET | `/api/v1/search/semantic/contracts/:address` | Find similar contracts |
| GET | `/api/v1/suggest` | Prefix/suffix autocomplete |
| GET | `/api/v1/search/index/status` | Index rebuild status |

### 6.2 NLQ Endpoints (Enhanced)

Existing endpoints in `nlq.ts` are enhanced with:
- LLM-based query translation (replacing regex-only intent classification)
- SQL generation and validation
- Query explanation in natural language
- Conversation memory across turns

## 7. Indexing Pipeline

```
Ledger Ingestion → Transaction/Event/Contract Extraction
    → Inverted Index Update → N-gram Generation → Embedding Generation (async)
    → Search Document Write (PostgreSQL)
```

### 7.1 Real-time Indexing

The indexer (`src/indexer/`) writes to search tables in the same transaction as primary data:
1. Transaction processed → `SearchDocument` created/updated
2. N-grams generated for address/name fields
3. Embedding queued for async generation (via background worker)

### 7.2 Batch Rebuild

`POST /api/v1/search/index/rebuild`:
1. Clears all search tables
2. Batch reads from primary tables (10k chunks)
3. Generates documents, n-grams, and embeddings
4. Reports progress via `/status` endpoint

## 8. Performance Testing

| Scenario | Target | Method |
|----------|--------|--------|
| Full-text 1B txns | < 100ms p99 | `EXPLAIN ANALYZE` with realistic data |
| Semantic 100k | < 200ms p99 | Vector index scan timing |
| NLQ→SQL | < 2s | End-to-end timing with mock LLM |
| Index freshness | < 5s | Poll index after ingestion |
| Full rebuild 100M | < 2h | Batch insert timing with parallel workers |

## 9. Monitoring

- `search_query_duration_ms` — Histogram of search query times
- `search_index_lag_seconds` — Lag between primary data and search index
- `search_embedding_queue_depth` — Pending embedding generation jobs
- `nlq_translation_time_ms` — NLQ→SQL translation time
- `search_semantic_recall` — Recall@10 for semantic similarity queries
