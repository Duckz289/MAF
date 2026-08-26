-- Session 6 / Context OS Phase 1b: provenance-bound compiled knowledge and conflict state.
-- Existing rows retain revision-global semantics because their staleness_inputs remain empty.
ALTER TABLE project_knowledge
  ADD COLUMN IF NOT EXISTS staleness_inputs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(staleness_inputs) = 'array' AND jsonb_array_length(staleness_inputs) <= 256),
  ADD COLUMN IF NOT EXISTS scope jsonb,
  ADD COLUMN IF NOT EXISTS compilation jsonb;

ALTER TABLE project_knowledge
  DROP CONSTRAINT IF EXISTS project_knowledge_status_check;

ALTER TABLE project_knowledge
  ADD CONSTRAINT project_knowledge_status_check
  CHECK (status IN ('ACTIVE', 'STALE', 'CONFLICTED'));

CREATE INDEX IF NOT EXISTS project_knowledge_project_status_idx
  ON project_knowledge(project_id, status, created_at DESC, id);
