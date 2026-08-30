-- Session 5: the ProjectBrain port now has one durable, provenance-bound backing table.
-- The earlier fact/evidence tables in migration 001 were never wired to the port and do not carry
-- enough source identity for safe idempotent writes. They remain untouched for compatibility.
CREATE TABLE IF NOT EXISTS project_knowledge (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  revision text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FACT', 'INFERENCE', 'EVIDENCE', 'DECISION')),
  statement text NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids) = 'array' AND jsonb_array_length(evidence_ids) <= 256
  ),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'STALE')),
  created_at timestamptz NOT NULL,
  producer text NOT NULL CHECK (
    producer IN ('LOCAL_REPOSITORY_INDEX', 'VERIFIED_RUN', 'EXPLICIT_PROJECT_ASSERTION')
  ),
  source text NOT NULL CHECK (
    source IN ('REPOSITORY_SNAPSHOT', 'VERIFICATION', 'USER_ASSERTION')
  ),
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  run_id text,
  identity_digest text UNIQUE NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS project_knowledge_active_revision_idx
  ON project_knowledge(project_id, revision, kind, created_at DESC)
  WHERE status = 'ACTIVE';
