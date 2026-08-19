# Adaptive hardening V0.1.1 execution plan

## Goal

Make repository perception, adaptive transitions, stabilization, and verifier failure history
trustworthy without adding another controller model or implementing the Recovery V0.2 plane.

## Scope

- Deterministic workspace, package, `src/<layer>`, and `src/features/<feature>` module ownership.
- Reversible `STRICT` using deltas from the `STRICT` entry snapshot.
- Multi-signal stabilization with explicit invalidation evidence.
- One bounded repair and at most two trusted verification attempts by default.
- Candidate/attempt lineage, telemetry, realistic fixtures, and focused tests.

## Delivered implementation

- `RepositorySnapshot` exposes both module maps and direct file ownership with reusable fallback
  rules for newly created files.
- Cross-module edges and dependency expansion use the same ownership source.
- Small `STRICT` re-expansion selects `GUIDED`; significant coupled expansion selects
  `SOLO_NATIVE`.
- Three-observation hysteresis prevents adjacent narrowing or cumulative-counter re-escalation.
- Stabilization can be invalidated by new files, modules, dependency edges, or trusted verifier
  failure; mechanical work becomes false at the same checkpoint.
- Failed verification sends bounded structured evidence to a resumable session only when honestly
  supported, otherwise a new bounded session in the same worktree.
- Verification rows contain attempt and candidate IDs; diff artifacts contain parent lineage.
- Telemetry and the benchmark schema include attempts, failures, repairs, module observations,
  invalidations, and `STRICT` re-expansions.

## Explicit limitations

- Local imports are resolved deterministically only for relative JavaScript/TypeScript source paths;
  compiler aliases and language-server semantics are not inferred.
- Workspace glob support is intentionally limited to direct deterministic roots.
- Stabilization and mechanical-work classification remain medium-reliability heuristics.
- All current bundled agent adapters advertise no persistent resume, so repair starts a new bounded
  session in the existing worktree.
- Recovery capsules, cross-process resume, provider/model failover, budget recovery, and circuit
  breakers remain V0.2 work.

## Validation status

- `npm run format:check`, `lint`, `typecheck`, `test`, `build`, `compose:check`, and `smoke`: passed.
- `npm run validate`: passed with 10 files and 44 tests.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `npm run benchmark:fixture`: both samples verified; the adaptive sample observed five realistic
  modules and transitioned `GUIDED -> SOLO_NATIVE -> STRICT -> GUIDED`; unknown cost stayed `null`.
- Migration `003_adaptive_hardening.sql` and the PostgreSQL-backed smoke path passed; verification
  attempt and candidate columns were queried from the migrated database.
- `npm run real-agent:smoke`: `REAL_AGENT_VERIFIED` through Claude Code in a disposable worktree;
  provider-reported cost was USD 0.169755.
