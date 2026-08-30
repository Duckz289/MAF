ALTER TABLE verifications
  ADD COLUMN IF NOT EXISTS verification_spec_identity text,
  ADD COLUMN IF NOT EXISTS candidate_digest text,
  ADD COLUMN IF NOT EXISTS environment jsonb,
  ADD COLUMN IF NOT EXISTS authority jsonb;
