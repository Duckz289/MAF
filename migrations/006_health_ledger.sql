-- M11 codebase health ledger: append-only longitudinal samples. One row per sample; every metric
-- group (structural/change/operational) is optional inside the payload — absence means not
-- measured, never a default good value.
CREATE TABLE IF NOT EXISTS health_samples (
    id uuid PRIMARY KEY,
    project_id text NOT NULL,
    revision text NOT NULL,
    timestamp timestamptz NOT NULL,
    run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
    candidate_id uuid NOT NULL REFERENCES artifacts(id),
    candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
    evidence_basis text NOT NULL CHECK (evidence_basis = 'VERIFIED_CANDIDATE'),
    payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS health_samples_project_timestamp_idx
    ON health_samples (project_id, timestamp, run_id);
