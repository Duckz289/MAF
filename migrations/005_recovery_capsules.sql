-- M3 recovery plane: durable, model-independent recovery state. Preserved independently of
-- worktree/sandbox cleanup so a PAUSED run can be resumed after a process restart.
CREATE TABLE IF NOT EXISTS recovery_capsules (
  run_id uuid PRIMARY KEY REFERENCES runs(id),
  recovery_reason text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
