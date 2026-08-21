CREATE TABLE IF NOT EXISTS delivery_handoffs (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  base_revision text NOT NULL,
  ci_head_revision text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ci_run_bindings (
  provider text NOT NULL,
  external_run_id text NOT NULL,
  handoff_id uuid NOT NULL REFERENCES delivery_handoffs(id) ON DELETE CASCADE,
  head_revision text,
  PRIMARY KEY (provider, external_run_id)
);

CREATE TABLE IF NOT EXISTS ci_evidence (
  id uuid PRIMARY KEY,
  handoff_id uuid NOT NULL REFERENCES delivery_handoffs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_run_id text NOT NULL,
  conclusion text NOT NULL CHECK (conclusion IN ('PENDING', 'PASS', 'FAIL', 'CANCELLED')),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (provider, external_run_id, observed_at)
);

CREATE INDEX IF NOT EXISTS ci_evidence_handoff_observed_idx
  ON ci_evidence(handoff_id, observed_at, id);
