CREATE TABLE IF NOT EXISTS production_feedback (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  release_revision text NOT NULL,
  feedback_type text NOT NULL CHECK (feedback_type IN ('INCIDENT', 'ROLLBACK', 'ERROR_RATE_REGRESSION', 'LATENCY_REGRESSION', 'SECURITY_FINDING')),
  severity text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  strategy jsonb NOT NULL,
  scope jsonb NOT NULL,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  UNIQUE(provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS production_feedback_project_observed_idx
  ON production_feedback(project_id, observed_at, id);
