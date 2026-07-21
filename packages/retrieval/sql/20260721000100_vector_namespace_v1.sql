-- AnalyticDB for PostgreSQL schema owned by @reflo/retrieval (D-GH-9).
-- Apply once per physically isolated environment with a DDL-only identity.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS reflo_source_span_embedding_v1 (
  owner_scope_id uuid NOT NULL,
  source_span_id uuid NOT NULL,
  embedding_generation_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  embedding_profile_version text NOT NULL CHECK (embedding_profile_version = 'embedding-v1'),
  embedding_input_hash text NOT NULL CHECK (embedding_input_hash ~ '^[a-f0-9]{64}$'),
  dimensions integer NOT NULL CHECK (dimensions = 1024),
  distance_metric text NOT NULL CHECK (distance_metric = 'cosine'),
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_scope_id, source_span_id, embedding_generation_id),
  UNIQUE (owner_scope_id, source_document_id, embedding_generation_id, source_span_id),
  CHECK (vector_dims(embedding) = 1024)
);

CREATE INDEX IF NOT EXISTS reflo_source_span_embedding_exact_lookup_idx
  ON reflo_source_span_embedding_v1
  (owner_scope_id, source_document_id, embedding_generation_id, source_span_id);

-- Exact cosine search is the sprint default. Do not add HNSW until the
-- D-GH-9 filtered recall and latency activation benchmark passes.
