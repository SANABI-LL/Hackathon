SET CLUSTER SETTING feature.vector_index.enabled = true;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email STRING,
  display_name STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_type STRING NOT NULL,
  file_name STRING,
  mime_type STRING,
  s3_bucket STRING,
  s3_key STRING,
  text_hash STRING NOT NULL,
  text_preview STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, text_hash)
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES memory_documents (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content STRING NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS deadlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_id UUID REFERENCES memory_documents (id) ON DELETE SET NULL,
  title STRING NOT NULL,
  due_date DATE NOT NULL,
  description STRING,
  confidence FLOAT8 NOT NULL DEFAULT 0,
  status STRING NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, title, due_date)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_id UUID REFERENCES memory_documents (id) ON DELETE SET NULL,
  event_type STRING NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role STRING NOT NULL,
  content STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_documents_user_created_idx
  ON memory_documents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_chunks_user_document_idx
  ON memory_chunks (user_id, document_id, chunk_index);

CREATE VECTOR INDEX ON memory_chunks (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS deadlines_user_due_date_idx
  ON deadlines (user_id, due_date);

CREATE INDEX IF NOT EXISTS agent_events_user_created_idx
  ON agent_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_user_created_idx
  ON messages (user_id, created_at DESC);
