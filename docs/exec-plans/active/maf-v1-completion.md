# MAF v1 completion program

Canonical ledger for the M1–M15 roadmap that evolves MAF from an adaptive-agent harness into an
adaptive software-engineering control plane. Decisions and evidence only; no hidden reasoning.

## Program state

- Start branch: `adaptive-harness/runtime-signals-v0.1` at `357ab60` (clean tree).
- Baseline validation (2026-08-19): `format:check`, `lint`, `typecheck`, `test` (49 passing),
  `build` (server + UI), `compose:check`, `smoke` — all PASS.
- Current milestone: M1 — Execution Policy Enforcement.

## Confirmed repository facts

- `Run.executionMode` is mutated by `AdaptiveModeController.apply` the moment a decision is made
  (`src/domain/mode-controller.ts`, `src/application/run-service.ts#observeAndDecide`); a running
  native session keeps the policy/context/env (`HARNESS_MODE`) it started with. The M1 gap exists.
- Agent sessions are one-shot processes today (fixture reads one stdin line, works, exits);
  decisions made mid-session are never delivered to the session.
- `LocalRepositoryIndex` truncates silently: `git ls-files` capped at 4 000 files, source parsing
  capped at 500 files, per-file cap 1 MB (`src/infrastructure/project-brain.ts`). The M2 gap exists.
- Verification: `CommandVerifier` (command / expectedFile / diff-nonempty), one bounded repair
  attempt, verified-only handoff. No recovery plane, no budget authority, no risk profiling.
- Store: `RunStore` (in-memory + Postgres, payload-jsonb pattern). Migrations numbered under
  `migrations/`.
- UI: Fluent-UI product workspace, recently redesigned — do not redesign; extend minimally.
  Some user-facing strings are Vietnamese; match surrounding language when editing.

## Milestones

| # | Milestone | Status | Commit |
|---|-----------|--------|--------|
| M1 | Execution policy enforcement | DONE (VERIFIED) | (pending local commit) |
| M2 | Scalable incremental project graph | NOT STARTED | |
| M3 | Recovery plane (3A–3D) | NOT STARTED | |
| M4 | Budget authority (4A–4E) | NOT STARTED | |
| M5 | Task risk profiler + assurance planner | NOT STARTED | |
| M6 | Quality governance (6A–6B) | NOT STARTED | |
| M7 | Architecture governance + debt delta | NOT STARTED | |
| M8 | Security assurance (8A–8B) | NOT STARTED | |
| M9 | Performance & runtime assurance | NOT STARTED | |
| M10 | Production-like resilience | NOT STARTED | |
| M11 | Longitudinal governance | NOT STARTED | |
| M12 | Frontier baselines + strategy learning | NOT STARTED | |
| M13 | PR / CI integration | NOT STARTED | |
| M14 | Production feedback foundations | NOT STARTED | |
| M15 | Integrated benchmark + hardening | NOT STARTED | |

## Architectural decisions

- D1 (M1): `Run` gains `desiredMode` and `effectiveMode`. `executionMode` is preserved as a
  compatibility mirror of `effectiveMode` so existing consumers (UI, telemetry, Postgres columns,
  benchmark) keep working. Desired state is never displayed as effective.
- D2 (M1): Enforcement strategies, in planner order: `LIVE_UPDATE` (agent capability
  `livePolicyUpdate`, requires an explicit `policy` acknowledgement event carrying the exact
  `requestId` the harness issued before the mode becomes effective — an ack with the right mode
  but wrong/missing requestId is rejected as unverified), `SAFE_RESTART` (capability
  `safeSessionRestart`, only for broadening transitions while a session is active, bounded by
  `maxPolicyRestarts`), `DEFERRED_BOUNDARY` (applies at next safe execution boundary),
  `SESSION_BOUNDARY` (no active session: applies immediately, next session starts under the new
  policy). Tightening transitions never restart a session.
- D3 (M1): Mode decisions are computed against `desiredMode`; enforcement tracks `effectiveMode`.
  `ModeChangeRequested` records intent; `ModeChanged` records enforcement with method + evidence.
- D4 (M1): When effective mode changes at a boundary, the initial context is rebuilt for the next
  session (`ContextRebuilt` event) so the mode change has real execution consequences.
- D5 (M1, post-review): while a run is active, `ActiveRunState.run` is the single live `Run`
  object; `transition()`, `cancel()`, and `modeExplanation()` mutate/read that same reference
  instead of a fresh store clone, eliminating a dual-writer race with the `execute()` loop's own
  periodic `store.updateRun(run)` calls.

## Validation log

- 2026-08-19 baseline: full `npm run validate` equivalent green before any change (see above).
- 2026-08-19 M1: `format:check`, `lint`, `typecheck`, `test` (58 passing: 9 new policy-enforcement
  tests — live-update trajectory with acknowledgements, deferred boundary, safe restart with
  HARNESS_MODE evidence on the replacement session, forged-acknowledgement rejection, restart
  bound, desired-vs-effective honesty, externally requested transition, enforcement-planner unit
  tests), `build` (server + UI), `compose:check`, `smoke` — all PASS.
- 2026-08-19 M1 fresh-context review (independent subagent, no primed conclusion): found 3
  MATERIAL issues, all fixed before commit —
  1. `handlePolicyAcknowledgement` accepted an ack with a missing/mismatched `requestId` as long as
     `acknowledgedMode` matched, letting an agent self-enforce a live update it never received.
     Fixed to require an exact `requestId` echo; the fixture was extended to attempt a forged ack
     and a regression test (`tests/policy-enforcement.integration.test.ts`) asserts it is rejected
     while the real one is bound and enforced.
  2. `transition()` and `cancel()` fetched a fresh store clone while the running `execute()` loop
     held its own live `Run` object; concurrent writers could desynchronize persisted state from
     the appended `ModeChanged` events. Fixed by giving `ActiveRunState` a single shared `run`
     reference that all external mutators (`transition`, `cancel`, `modeExplanation`) use while a
     run is active, so there is exactly one writer.
  3. Migration 004 backfilled the new `desired_mode`/`effective_mode` *columns*, but
     `PostgresRunStore` hydrates `Run` exclusively from the `payload` jsonb, so legacy rows would
     come back with `undefined` desired/effective mode. Fixed the migration to `jsonb_set` the
     payload itself, plus a defensive hydration fallback in `postgres/store.ts` that mirrors
     `executionMode` if a future gap is ever found (never invents a different value).
  Also addressed as minors: silently-superseded pending policies now emit
  `ModeEnforcementSuperseded`; a same-to-same enforcement (a flip-flopped desired mode landing back
  on the current effective mode) now emits `ModeEnforcementNoop` instead of a misleading
  same-value `ModeChanged`; a `SAFE_RESTART` mid-repair now continues with the actual repair
  message instead of silently discarding it for the original task prompt; the new UI field label
  was made consistent with its English siblings. Not fixed (documented, low priority): pending
  enforcement state is process-local (moot until runs survive a process restart — tracked under
  M3 recovery); the deterministic-vs-claimed nature of agent-reported file-touch evidence feeding
  mode decisions is a pre-existing, pre-M1 property of the runtime-signal collector, not something
  M1 introduced.
- All fixes re-validated: `typecheck`, `test` (58 passing), `format:check`, `lint`, `build`,
  `compose:check`, `smoke` — all PASS after the review round.

## Blockers

- None.

## Deferred work

- Real-agent smoke (`npm run real-agent:smoke`) requires an authenticated Claude Code CLI; will run
  only if available and bounded.
