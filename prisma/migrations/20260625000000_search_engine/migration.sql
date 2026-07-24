-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Search documents: unified inverted index
CREATE TABLE IF NOT EXISTS "search_documents" (
    "id" TEXT PRIMARY KEY,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_documents_type_id ON "search_documents" ("doc_type", "doc_id");
CREATE INDEX IF NOT EXISTS idx_search_documents_type ON "search_documents" ("doc_type");
CREATE INDEX IF NOT EXISTS idx_search_documents_trgm ON "search_documents" USING GIN ("content" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_search_documents_tsv ON "search_documents" USING GIN (to_tsvector('english', "content"));

-- N-gram index for typo-tolerant fuzzy matching
CREATE TABLE IF NOT EXISTS "search_n_grams" (
    "id" TEXT PRIMARY KEY,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "gram" TEXT NOT NULL,
    "position" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_ngrams_gram ON "search_n_grams" ("gram");
CREATE INDEX IF NOT EXISTS idx_search_ngrams_type_doc ON "search_n_grams" ("doc_type", "doc_id");

-- Autocomplete suggestions
CREATE TABLE IF NOT EXISTS "search_suggestions" (
    "id" TEXT PRIMARY KEY,
    "prefix" TEXT NOT NULL,
    "suffix" TEXT,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_suggestions_prefix ON "search_suggestions" ("prefix");
CREATE INDEX IF NOT EXISTS idx_search_suggestions_suffix ON "search_suggestions" ("suffix");
CREATE INDEX IF NOT EXISTS idx_search_suggestions_type_prefix ON "search_suggestions" ("doc_type", "prefix");

-- Contract vector embeddings (768-dim for CodeBERT)
CREATE TABLE IF NOT EXISTS "contract_embeddings" (
    "id" TEXT PRIMARY KEY,
    "contract_address" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "content_hash" TEXT,
    "source_type" TEXT NOT NULL DEFAULT 'code',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_embeddings_address ON "contract_embeddings" ("contract_address");
CREATE INDEX IF NOT EXISTS idx_contract_embeddings_model ON "contract_embeddings" ("model_name");
CREATE INDEX IF NOT EXISTS idx_contract_embeddings_vector ON "contract_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 200);

-- Transaction/text vector embeddings (384-dim for Sentence-BERT)
CREATE TABLE IF NOT EXISTS "tx_embeddings" (
    "id" TEXT PRIMARY KEY,
    "tx_hash" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "content_text" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_embeddings_hash ON "tx_embeddings" ("tx_hash");
CREATE INDEX IF NOT EXISTS idx_tx_embeddings_vector ON "tx_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Event parameter embeddings (384-dim)
CREATE TABLE IF NOT EXISTS "event_embeddings" (
    "id" TEXT PRIMARY KEY,
    "event_id" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "param_types" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_embeddings_event ON "event_embeddings" ("event_id");
CREATE INDEX IF NOT EXISTS idx_event_embeddings_vector ON "event_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 50);

-- Index state tracking
CREATE TABLE IF NOT EXISTS "search_index_state" (
    "id" TEXT PRIMARY KEY DEFAULT 'singleton',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "progress" REAL NOT NULL DEFAULT 0,
    "total_docs" INTEGER NOT NULL DEFAULT 0,
    "indexed_docs" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "error" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "search_index_state" ("id", "status") VALUES ('singleton', 'idle') ON CONFLICT ("id") DO NOTHING;
