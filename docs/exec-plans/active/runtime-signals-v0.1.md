# Runtime signals V0.1 execution plan

## Goal

Replace request-time adaptive flags with observed repository and execution evidence, expose
explanations in the API and dashboard, retain native-agent capabilities, and make benchmark cost
accounting honest.

## Delivered

- Evidence-backed collector across initial context, tool events, diff, and verification checkpoints.
- Deterministic local import resolution, meaningful cross-module edges, stabilization rules, and
  anti-oscillation policy.
- Snapshot persistence, event linkage, explanation API, adaptive telemetry, and dashboard panel.
- Reference-only native-agent credential boundary with recursive redaction and canary integration
  test.
- Claude Code native smoke path and executable native-versus-adaptive benchmark harness.
- Unit, integration, API, database smoke, and production-build validation paths.

## Validation record

- Baseline `npm run validate`: passed with 18 tests before implementation.
- `npm run real-agent:smoke`: `REAL_AGENT_VERIFIED` with Claude Code in a disposable repository;
  provider-reported cost was USD 0.177858 for that run.
- `npm run benchmark:fixture`: two verified local executor samples; cost remained unknown/`null`.
- PostgreSQL `npm run migrate` and database-backed `npm run smoke`: passed; snapshots and transition
  evidence links were queried from the migrated tables.
- Final `npm run validate`: passed with 32 tests, production server/UI builds, Compose validation,
  and smoke execution.
- `npm audit --audit-level=low`: zero vulnerabilities.

Pushed commit IDs are recorded in the implementation handoff after commit creation.
