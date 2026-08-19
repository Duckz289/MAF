ALTER TABLE verifications ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS candidate_id uuid;

CREATE INDEX IF NOT EXISTS verifications_run_attempt_idx
  ON verifications(run_id, attempt);

