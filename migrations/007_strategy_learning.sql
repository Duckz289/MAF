-- M12 store-bound strategy outcomes. Benchmark/shadow observations remain report-local and cannot
-- be inserted here: durable rows are one-to-one with terminal run/candidate records, and the
-- evidence basis distinguishes verified success from a terminal verifier failure.
CREATE TABLE IF NOT EXISTS strategy_observations (
    id uuid PRIMARY KEY,
    observation_id text NOT NULL UNIQUE,
    project_id text NOT NULL,
    timestamp timestamptz NOT NULL,
    run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
    candidate_id uuid NOT NULL REFERENCES artifacts(id),
    candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
    evidence_basis text NOT NULL CHECK (
        evidence_basis IN ('RUN_STORE_VERIFIED', 'RUN_STORE_TERMINAL')
    ),
    payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS strategy_observations_project_timestamp_idx
    ON strategy_observations (project_id, timestamp, run_id);

CREATE TABLE IF NOT EXISTS strategy_canary_counters (
    allocation_key text PRIMARY KEY CHECK (allocation_key ~ '^strategy-[0-9a-f]{64}$'),
    next_ordinal bigint NOT NULL CHECK (next_ordinal >= 0)
);
