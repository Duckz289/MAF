# MAF v1 completion program

Canonical ledger for the M1–M15 roadmap that evolves MAF from an adaptive-agent harness into an
adaptive software-engineering control plane. Decisions and evidence only; no hidden reasoning.

## Program state

- Start branch: `adaptive-harness/runtime-signals-v0.1` at `357ab60` (clean tree).
- Baseline validation (2026-08-19): `format:check`, `lint`, `typecheck`, `test` (49 passing),
  `build` (server + UI), `compose:check`, `smoke` — all PASS.
- Current milestone: M3 — Recovery Plane.

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
| M1 | Execution policy enforcement | DONE (VERIFIED) | 459e710 |
| M2 | Scalable incremental project graph | DONE (VERIFIED) | 5cd71ed |
| M3 | Recovery plane (3A–3D) | DONE (VERIFIED) | (pending local commit) |
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

## M2 design (Scalable Incremental Project Graph)

Confirmed bug motivating this milestone: `LocalRepositoryIndex.index()` today (1) slices
`git ls-files` output to the first 4 000 entries and (2) parses symbols/relations/module
ownership for only the first 500 of those, in listing order — meaning `moduleMap` /
`moduleOwnership` themselves (not just symbols) are silently incomplete on any repository larger
than 500 tracked files, and files entirely outside the first 4 000 do not exist in the graph at
all. Because `RunService` indexes once up front and never updates the snapshot the collector holds
(`EvidenceRuntimeSignalCollector`'s `state.repository` is frozen from `INITIAL_CONTEXT`), the M1
adaptive-mode cross-module-edge/dependency-expansion signals silently under-count for any file
touched beyond that frozen, capped snapshot on a large repository.

Design:
1. Split indexing into a cheap full pass and a bounded scoped pass:
   - `index()` now enumerates all tracked files (git ls-files, no 4 000 cap — a 100 000-file safety
     ceiling with an honest `filesTruncated` flag replaces the silent slice) and derives
     `moduleRoots` (packages/workspaces), `packageOwnership` (file → package/workspace root), and
     `moduleOwnership` (file → deeper architectural module, e.g. `apps/web/src/domain`, falling
     back to the package root when no deeper convention applies) from **paths alone** — no file
     content is read, so this stays cheap at any repository size. `symbols`/`relations` start empty.
   - `indexScope(repositoryPath, revision, snapshot, files)` parses symbols and resolved local
     import relations for exactly the requested files and merges them onto the snapshot. Each
     file's parse is cached by content digest (`Map<absolutePath, {digest, symbols, relations}>`);
     unchanged files are never re-parsed.
2. `src/domain/module-ownership.ts`: `packageOwnerForFile` (new) returns the outer package/
   workspace root; `moduleOwnerForFile` (existing name, refined) returns the deeper architectural
   module within that package when a `src/<layer>` or `src/features/<name>` convention is present,
   else the package root — preserving both, per the milestone's `apps/web` package /
   `apps/web/src/domain` module example. Backward compatible with all existing module-ownership
   test fixtures (verified: single-package `src/*` and workspace-root-only cases produce identical
   output to the pre-M2 function).
3. `RunService` now owns an incremental graph: it builds the cheap snapshot, asks
   `ContextBuilderPort` for the initial scope, scope-indexes exactly that scope, and re-renders the
   context text with real symbols for that scope (two bounded `contextBuilder.build` calls — the
   first selects scope from path/module data alone, cheap; the second renders text once the scope
   is enriched with parsed symbols). As the agent touches new files (tool events, diffs), RunService
   extracts candidate files (shared `extractFileCandidates`/`findRepositoryFile` helpers, moved to
   `src/application/file-candidates.ts` so RunService and the signal collector share one
   implementation) and scope-indexes any not yet parsed, growing the same snapshot instance rather
   than starting over.
4. `RuntimeObservation`'s `AGENT_EVENT`/`DIFF_CAPTURED` variants gain an optional `repository`
   field carrying the latest incrementally-grown snapshot; the collector merges it before computing
   cross-module edges, so dependency-expansion and cross-module-edge signals reflect real resolved
   relations for whatever has actually been touched, never a frozen initial slice.
5. Relationship kinds stay `IMPORTS` (resolved local import edges, deterministic) and the new
   `moduleOwnership`/`packageOwnership` maps are path-derived and deterministic; no relationship is
   ever labeled deterministic from LLM/agent-claimed data — cross-module edges still require the
   file to exist in the repository snapshot AND the import to be a real resolved local specifier.

## M2 validation log

- Initial pass: `typecheck`, `format:check`, `lint`, `test` (62 passing), `build`, `compose:check`,
  `smoke` — all PASS.
- Fresh-context review (independent subagent, diff-only, no primed conclusion) found 2 MATERIAL
  issues, both fixed before commit:
  1. The `parsedFiles` membership check gated `indexScope` entirely — once a file was scope-indexed
     once, it was permanently excluded from ever being re-parsed for the rest of the run, so the
     digest-based cache-invalidation logic was unreachable dead code. An agent editing a
     previously-touched file would carry silently stale symbols/relations for the remainder of the
     run — the same class of bug M2 exists to eliminate, reintroduced by a different mechanism.
     Fixed by removing the `parsedFiles` gate entirely: `indexScope` now always re-checks every
     requested file's live content digest against the digest already recorded in the snapshot's own
     `evidence` array, and only skips re-parsing when that digest is unchanged. Proven by a new test
     ("re-parses a file whose content changed since it was last scope-indexed") that edits a file on
     disk between two `indexScope` calls and asserts the stale relation is replaced by the fresh one.
  2. `LocalRepositoryIndex.parseCache` was a `Map` on the singleton instance (one per server
     process, shared across all runs — `src/server/app.ts`), keyed by sandbox-specific absolute
     paths that are unique per run and never evicted: unbounded growth across the server's
     lifetime. Fixed by removing the cross-call cache field entirely — the redesign in (1) makes
     the snapshot's own per-file evidence digest the complete cache, which is naturally scoped to
     the snapshot/run it belongs to and is garbage-collected with it. Both material fixes came from
     the same redesign.
  Also addressed as minors from the same review: `indexScope`'s own per-call truncation
  (`MAX_SCOPE_FILES_PER_CALL`) is now honestly surfaced via a `scopeTruncated` snapshot flag and a
  `ScopeIndexTruncated` event, instead of silently truncating like the pre-M2 file-count cap did; a
  file the agent creates mid-run (invisible to the frozen initial `git ls-files` listing) is now
  registered into the snapshot's files/module/package maps the first time a *trusted* path (git
  status output, or context-builder's own module ranking) references it — proven by a new test
  ("registers a file created mid-run and resolves imports that target it"); `growGraph`/`indexScope`
  failures are now caught and degrade to "no growth" plus an honest `ScopeIndexFailed` event rather
  than failing the whole run over enrichment-only signal quality. Not fixed (documented, low
  priority): candidate paths extracted from agent tool-call JSON (as opposed to git-status or
  context-builder output) still only resolve against the known-files list, so a brand-new file an
  agent references purely by tool-call path (before any diff/context-builder call sees it) may not
  be registered on that specific event — a narrower, lower-impact version of the same gap, still
  closed on the next diff capture.
- Re-validated after fixes: `typecheck`, `test` (64 passing), `format:check`, `lint`, `build`,
  `compose:check`, `smoke` — all PASS.

## M3 design notes (Recovery Plane) — drafted while M2 review is in flight, not yet implemented

Confirmed starting point: `docs/design-docs/adaptive-control-plane.md` already states "Persistent
recovery state, provider/model failover, cross-process resume, budget recovery, and circuit
breakers remain deferred to Recovery V0.2" — i.e. M3 is greenfield, not a rework of an existing
mechanism. Candidate lineage already exists implicitly (`Artifact.metadata.parentCandidateId`,
`Verification.attempt`/`candidateId`), so M3A formalizes rather than invents it.

Planned scope for this pass (kept intentionally bounded to avoid pulling in M4-M15 territory):
1. `src/domain/recovery.ts`: `FailureClassification` taxonomy (the twelve categories from the
   roadmap) with a deterministic `classifyFailure(error, context)` — pattern-matches known
   error/exit-code shapes, defaults honestly to `UNKNOWN_FAILURE` rather than guessing. A
   retryability table per category (bounded-retryable vs requires-explicit-resume) — conservative
   by default: only PROVIDER_TRANSIENT / PROVIDER_DEGRADED / RATE_LIMIT / NETWORK_FAILURE /
   AGENT_FAILURE / VERIFICATION_FAILURE are auto-retryable; CREDENTIAL_FAILURE / ENVIRONMENT_FAILURE
   / BUDGET_EXHAUSTED / USER_INTERRUPT / REVISION_CONFLICT / UNKNOWN_FAILURE require explicit
   resume/escalation — matches "failure must not lower trust" and "no unbounded loops".
2. `RecoveryCapsule` domain type: run/task identity, goal, base revision, workspace path,
   candidate lineage summary, verified facts/decisions (from ProjectBrain), latest verification
   evidence, latest runtime-signal snapshot, desired/effective mode, agent/provider identity,
   cost spent, recovery reason/classification. No chain-of-thought is ever serialized — only
   already-structured evidence the system already tracks.
3. `RunState` gains `PAUSED` (additive; UI/telemetry degrade gracefully to a generic badge for
   unrecognized states already, confirmed via `src/web/components/StatusBadge.tsx`).
4. `RunService`: on an unhandled execution failure, classify it, build a capsule, and — bounded by
   a `maxRecoveryAttempts` policy — either retry with a new bounded session (reusing the existing
   agent/workspace, honest about not yet having a second provider wired) or persist the capsule and
   move the run to `PAUSED` rather than silently `FAILED`.
5. Candidate lineage helper: pure `strongestCandidate(candidates, verifications)` so a failed
   repair cannot silently discard an earlier better-verified candidate.
6. Emergency stop: `RunService.emergencyStop()` cancels all active runs (worktrees/evidence
   preserved via existing retention policy, which already keeps non-VERIFIED sandboxes) and blocks
   new run creation until explicitly resumed.
7. Revision-conflict detection (M3C): resuming a paused run checks the capsule's base revision
   against the sandbox's current revision before trusting prior evidence; a mismatch marks that
   evidence stale rather than blindly resuming.

Explicitly deferred and will be stated as NOT IMPLEMENTED rather than overclaimed: cross-process
resume after a server restart (capsules are persisted, but nothing yet reloads/resumes a `PAUSED`
run after process restart), true provider/model failover (only one native adapter is wired today —
the retry-with-new-session path stays within the same agent), and circuit breakers (M4E).

## M3 validation log

- Initial pass: `typecheck`, `format:check`, `lint`, `test` (80 passing: 11 new unit tests for
  `src/domain/recovery.ts` — classifyFailure pattern coverage, isAutoRetryable boundary,
  candidateLineage/strongestCandidate never letting a worse later attempt hide a stronger earlier
  one, buildRecoveryCapsule never containing anything beyond known structured fields; 5 new
  integration tests — bounded auto-retry with a fresh session and no capsule when recovery
  succeeds, capsule capture + PAUSED on a non-retryable failure, resume from a preserved worktree
  completing verified, resume refused on source-revision conflict, emergency stop cancelling
  active runs / blocking new creation / preserving evidence / lifting cleanly), `build`,
  `compose:check`, `smoke` — all PASS.
- A real bug was found and fixed during implementation (not by the external review — caught by the
  resume integration test itself): `EvidenceRuntimeSignalCollector.observe()` throws if asked to
  initialize `INITIAL_CONTEXT` for a runId it already has state for. Same-process `resume()` hit
  this immediately since the collector instance is shared. Fixed by checking
  `runtimeSignals.latest(run.id)` before emitting `INITIAL_CONTEXT` — skip it if state already
  exists (same-process resume), do the full init otherwise (a genuinely fresh run, or a
  hypothetical resume in a fresh process where nothing has been observed yet).
- A design correction was made before writing tests: the first revision-conflict draft compared
  the sandbox worktree's own HEAD to itself before vs. after pausing — which can never detect
  drift, since nothing touches the worktree between capture and resume. Corrected to compare the
  capsule's captured sandbox HEAD against a fresh resolution of the requested revision in the
  *source* repository at resume time — the scenario that actually matters ("the branch moved on
  while this run sat paused").
- Fresh-context review (independent subagent, diff-only, no primed conclusion) found 6 MATERIAL
  issues, all fixed before commit —
  1. `classifyFailure` pattern-matched agent-supplied error text (an `error` AgentEvent's
     `message`, entirely agent-controlled) into the full failure taxonomy, including
     `CREDENTIAL_FAILURE`/`NETWORK_FAILURE`/etc. and even the harness's own `"Run cancelled"`
     sentinel — letting agent output silently masquerade as harness-determined ground truth in the
     durable `RecoveryCapsule`, and letting an agent dodge capsule capture by claiming
     `USER_INTERRUPT`. Fixed with a new `AgentReportedFailure` marker class and a `agentReported`
     context flag: any agent-reported error is now always `AGENT_FAILURE` regardless of its text
     (already auto-retryable and bounded, so no capability was lost — only the false-ground-truth
     problem was closed). Proven by a regression test using a deliberately
     credential-failure-shaped agent message and a unit test enumerating every taxonomy category.
  2. `resume()` never checked `emergencyStopped`, so a paused run could be explicitly resumed
     (spawning a new agent session and provider spend) during an active emergency stop. Fixed with
     the same guard `create()` already had.
  3. `create()`/`resume()` raced `emergencyStop()`: both do several awaited store/event calls
     before registering the run in `this.active`, so a stop that landed during that window
     couldn't see the run in its cancellation sweep, and the run would still start its first agent
     session after the stop had already returned to its caller. Fixed by re-checking
     `emergencyStopped` immediately before the (synchronous, non-awaited) kick-off of `execute()`
     — closing the window with no lock needed. Proven by a regression test that wraps the store to
     trigger `emergencyStop()` at exactly that race window and asserts no agent session started.
  4. Recovery's usefulness silently depended on `SANDBOX_RETENTION` (with `=none` the sandbox is
     deleted immediately, so `resume()` would fail with an opaque filesystem/git error deep inside
     the next attempt). Fixed: `resume()` now checks the workspace exists on disk first and fails
     with a specific, actionable message naming the likely cause; documented in
     `docs/RELIABILITY.md`.
  5. The revision-conflict check only fired when both the capsule's and the freshly-resolved
     revision were known; a `resolveRevision` failure at either capture or resume time (both
     already best-effort/error-swallowing by design) silently degraded to "no conflict",
     the exact "blindly resume on stale ground" failure mode M3C exists to prevent. Fixed:
     an inconclusive check now refuses resume (`REVISION_UNKNOWN`) rather than proceeding —
     unknown stays unknown. Proven by a test that removes a capsule's `resolvedRevision` after
     capture and asserts refusal.
  6. `ARCHITECTURE.md`/`docs/RELIABILITY.md` claimed "a failed later repair can never cause an
     earlier better-verified candidate to be forgotten" without qualification — true only for
     candidate identity/verification-result metadata (which is durably preserved), not full diff
     content (only a 12,000-character preview is persisted outside the worktree, and the worktree
     itself reflects only the latest attempt). Softened to state the metadata-level guarantee
     precisely and note that physical workspace rollback is not implemented.
  Also addressed as a minor from the same review: `emergencyStop()`'s doc comment overstated its
  cancellation guarantee ("cancels active spending where safely possible") relative to the actual
  (pre-existing, shared with `cancel()`) mechanism, which cannot interrupt a session already inside
  `agent.start()`/`send()` before its first event arrives — reworded to state that bound honestly.
  Not fixed (documented as a known limitation rather than addressed): a same-process resume reuses
  in-memory runtime-signal history, while a resume in a fresh process re-seeds it from empty since
  that history is not itself persisted — noted in `docs/RELIABILITY.md`.
- Re-validated after fixes: `typecheck`, `test` (86 passing), `format:check`, `lint`, `build`,
  `compose:check`, `smoke` — all PASS. (One `smoke` flake was traced to an unrelated orphaned
  `dist/node/server/main.js` process left running on port 4310 from earlier in this session, not a
  regression — killed, and smoke was stable across repeated runs afterward.)

## Blockers

- None.

## Deferred work

- Real-agent smoke (`npm run real-agent:smoke`) requires an authenticated Claude Code CLI; will run
  only if available and bounded.
