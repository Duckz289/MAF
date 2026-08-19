# Adaptive harness bootstrap

## Goal

Build a runnable adaptive coding-agent harness around native agent loops with isolated execution,
verified-only handoff, structured project knowledge, credential mediation, telemetry, mission-tree
gating, and a multi-run dashboard.

## Architecture

Modular TypeScript monolith using dependency-inverted domain ports. PostgreSQL is the durable
production adapter; in-memory adapters keep tests and the fixture runner deterministic. External
systems remain package, protocol, or service adapters.

## Current phase

Phase 1 complete: the bootstrap, native-agent paths, durable store, trust gates, telemetry, and
operations dashboard are implemented and verified locally.

## Completed work

- Confirmed the workspace was empty and not a Git repository.
- Initialized Git on `adaptive-harness/bootstrap` without touching user work.
- Verified Node 24, npm, pnpm, Git, Docker, and Docker Compose.
- Resolved and shallow-cloned every requested upstream candidate.
- Recorded exact upstream commits and license boundaries.
- Implemented the dependency-inverted domain, application service, and infrastructure adapters.
- Implemented real native CLI and stable ACP subprocess paths with streaming, cancellation, and
  sandbox-constrained file access.
- Implemented adaptive `STRICT`, `GUIDED`, and `SOLO_NATIVE` transitions with persisted evidence.
- Implemented local Git-worktree isolation, diff capture, verification, quarantine, and retention.
- Implemented repository indexing, actual ast-grep structural search, Project Brain evidence rules,
  revision staleness, mission-tree dependency gates, and verified-only handoff.
- Implemented PostgreSQL persistence and migration for run, graph, identity, credential-reference,
  mission, and telemetry records.
- Implemented Better Auth, Nango, Agent Vault, Bifrost, Langfuse, OpenTelemetry, and platform-key
  boundaries without placing provider secrets in agent context.
- Implemented the Fastify control API, SSE lifecycle feed, and responsive Fluent UI operations
  dashboard with loading, empty, error, filtering, stuck-run, mode-transition, and trust states.
- Added deterministic fixture agents, unit/integration tests, production smoke tests, and benchmark
  dataset/result schemas.

## Current blockers

None.

## Important discoveries

- Nango uses Elastic License 2.0; integrate only through its SDK/API boundary.
- Unkey server code is AGPLv3; keep an API-key port/schema and do not vendor server code.
- ACP v1 is stable while ACP v2 remains draft; target the stable TypeScript package.
- Agent Vault and Langfuse have MIT cores with separately licensed enterprise directories.

## Decision log

- 2026-08-19: Use a modular monolith to avoid premature microservices.
- 2026-08-19: Keep native agents behind capability-preserving adapters.
- 2026-08-19: Use local Git worktrees as the default sandbox and retain failed workspaces.
- 2026-08-19: Use Fluent UI v9 for the dense operational dashboard.

## Verification results

- Git/environment audit: PASS.
- Upstream canonical URL, README, license, activity, and commit audit: PASS.
- `npm run validate`: PASS (format, lint, TypeScript, 7 files/18 tests, server/UI builds, Compose
  validation, production smoke).
- `npm audit --audit-level=low`: PASS (0 vulnerabilities).
- Production in-memory smoke: PASS (dashboard, verified and quarantined paths, adaptive transitions,
  SSE, and worktree cleanup).
- PostgreSQL 17 migration and production smoke: PASS; telemetry rows were persisted.
- `npm start`: PASS against PostgreSQL; `/health` returned `ok` and `/` returned the dashboard.

## Upstream versions

See [`../../UPSTREAMS.md`](../../UPSTREAMS.md).

## Known debt

- Real provider OAuth cannot be marked verified without external credentials; local mock flows will
  be labeled `MOCK_VERIFIED`.
- Docker/remote sandboxes and Unkey issuance remain explicit future adapters; the local Git-worktree
  sandbox and local hashed platform keys are the implemented V0 paths.
- External Bifrost, Nango, Agent Vault, and Langfuse services were contract-tested or tested through
  local HTTP doubles, but were not deployed because no provider credentials/endpoints were supplied.
