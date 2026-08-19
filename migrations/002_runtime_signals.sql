CREATE TABLE IF NOT EXISTS runtime_signal_snapshots (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL,
  checkpoint text NOT NULL,
  signals jsonb NOT NULL,
  evidence jsonb NOT NULL,
  timestamp timestamptz NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE INDEX IF NOT EXISTS runtime_signal_snapshots_run_sequence_idx
  ON runtime_signal_snapshots(run_id, sequence);

ALTER TABLE mode_transitions ADD COLUMN IF NOT EXISTS signal_snapshot_id uuid;
ALTER TABLE mode_transitions ADD COLUMN IF NOT EXISTS evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE telemetry ALTER COLUMN total_cost DROP NOT NULL;
