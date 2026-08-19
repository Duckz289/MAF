CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  repository_path text NOT NULL,
  revision text NOT NULL,
  prompt text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  state text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('STRICT', 'GUIDED', 'SOLO_NATIVE')),
  verification_state text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid UNIQUE NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id),
  type text NOT NULL,
  timestamp timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  kind text NOT NULL,
  uri text NOT NULL,
  digest text,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  type text NOT NULL,
  state text NOT NULL,
  command text,
  exit_code integer,
  output text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mode_transitions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  from_mode text NOT NULL,
  to_mode text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  timestamp timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  canonical_path text NOT NULL,
  UNIQUE(project_id, canonical_path)
);
CREATE TABLE IF NOT EXISTS revisions (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  git_sha text NOT NULL,
  indexed_at timestamptz NOT NULL,
  UNIQUE(repository_id, git_sha)
);
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  uri text NOT NULL,
  digest text NOT NULL,
  metadata jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  statement text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'STALE')),
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_evidence (
  fact_id uuid NOT NULL REFERENCES facts(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY(fact_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS inferences (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  statement text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  statement text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  path text NOT NULL,
  digest text,
  UNIQUE(revision_id, path)
);
CREATE TABLE IF NOT EXISTS symbols (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES files(id),
  name text NOT NULL,
  kind text NOT NULL,
  line integer NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES revisions(id),
  source_ref text NOT NULL,
  target_ref text NOT NULL,
  kind text NOT NULL,
  evidence_id uuid REFERENCES evidence(id)
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  session_reference text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS external_connections (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  provider text NOT NULL,
  connection_reference text NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL,
  UNIQUE(owner_id, provider)
);
CREATE TABLE IF NOT EXISTS credential_bindings (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  provider text NOT NULL,
  auth_strategy text NOT NULL,
  credential_reference text NOT NULL,
  scopes jsonb NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_api_keys (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  key_hash bytea NOT NULL,
  scopes jsonb NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id),
  execution_mode text NOT NULL,
  verification_state text NOT NULL,
  verified_success boolean NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cached_tokens bigint NOT NULL,
  total_cost numeric(18, 8) NOT NULL,
  latency_ms bigint NOT NULL,
  retry_count integer NOT NULL,
  payload jsonb NOT NULL,
  timestamp timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_nodes (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES mission_nodes(id),
  state text NOT NULL,
  execution_mode text NOT NULL,
  agent text NOT NULL,
  model text NOT NULL,
  budget numeric(18, 8) NOT NULL,
  inputs jsonb NOT NULL,
  outputs jsonb NOT NULL,
  verification_state text NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_dependencies (
  node_id uuid NOT NULL REFERENCES mission_nodes(id),
  dependency_id uuid NOT NULL REFERENCES mission_nodes(id),
  PRIMARY KEY(node_id, dependency_id)
);
