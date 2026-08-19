-- M1 execution policy enforcement: distinguish the desired adaptive mode from the mode actually
-- enforced on the running agent session. execution_mode remains a compatibility mirror of the
-- effective mode. Migrations re-run on every migrate call, so statements stay idempotent.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS desired_mode text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS effective_mode text;
UPDATE runs SET desired_mode = execution_mode WHERE desired_mode IS NULL;
UPDATE runs SET effective_mode = execution_mode WHERE effective_mode IS NULL;

-- PostgresRunStore hydrates Run exclusively from the payload jsonb column (not from these
-- generated columns), so legacy payloads must also gain desiredMode/effectiveMode. Without this,
-- pre-M1 runs would come back with those keys undefined despite the non-optional Run type, and
-- the desired/effective compatibility alias would silently regress for every legacy row.
UPDATE runs
SET payload = jsonb_set(
  jsonb_set(payload, '{desiredMode}', to_jsonb(execution_mode), true),
  '{effectiveMode}', to_jsonb(execution_mode), true
)
WHERE payload->>'desiredMode' IS NULL OR payload->>'effectiveMode' IS NULL;

-- Enforcement provenance for mode transitions (method + evidence live in events payloads too).
ALTER TABLE mode_transitions ADD COLUMN IF NOT EXISTS enforcement_method text;
