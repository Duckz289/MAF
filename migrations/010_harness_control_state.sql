-- Durable harness control state (Emergency Stop).
--
-- Emergency Stop previously lived only in RunService's process memory, so a restart silently
-- cleared it: the operator's explicit "stop accepting work" decision evaporated with the process
-- and new runs began again with no human involved. A safety control that a crash can revoke is
-- not a safety control. One row, keyed by name, holds it durably.
CREATE TABLE IF NOT EXISTS harness_control_state (
  name text PRIMARY KEY,
  emergency_stopped boolean NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL
);
