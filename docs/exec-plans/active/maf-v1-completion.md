# MAF v1 completion program

Canonical ledger for the M1–M15 roadmap that evolves MAF from an adaptive-agent harness into an
adaptive software-engineering control plane. Decisions and evidence only; no hidden reasoning.

## Program state

- Start branch: `adaptive-harness/runtime-signals-v0.1` at `357ab60` (clean tree).
- Baseline validation (2026-08-19): `format:check`, `lint`, `typecheck`, `test` (49 passing),
  `build` (server + UI), `compose:check`, `smoke` — all PASS.
- Current milestone: M7 — Architecture Governance and Technical Debt.

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
| M3 | Recovery plane (3A–3D) | DONE (VERIFIED) | 937dede |
| M4 | Budget authority (4A–4E) | DONE (VERIFIED) | 0994fa7 |
| M5 | Task risk profiler + assurance planner | DONE (VERIFIED) | cea4114 |
| M6 | Quality governance (6A–6G) | DONE (VERIFIED) | f86ef1a |
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

## M4 validation log

- `src/domain/budget.ts` (pure): `BudgetMode`/`BudgetCategory`/`BudgetPolicy`/
  `BudgetReservationPolicy`/`computeAllocation`/`authorizeSpend`/`CostEstimate`/
  `estimateFromHistory`/`BudgetExhaustedError`. `src/domain/circuit-breaker.ts` (pure):
  `ProviderCircuitBreaker`/`ProviderCircuitOpenError`, deterministic threshold-and-cooldown state
  machine (HEALTHY/DEGRADED/OPEN_CIRCUIT/HALF_OPEN), no model ever consulted.
- `RunService` gates: (1) before the first agent session — refuses to start at all
  (`BudgetExhaustedError` → capsule → `PAUSED`, `BUDGET_EXHAUSTED`) if even the execution reserve
  cannot fund it; (2) before each bounded repair attempt — stops repairing without ever upgrading
  the last verification result; (3) before each bounded recovery retry — skips the retry. A
  `ProviderCircuitBreaker` (one instance shared across all runs in a process) gates every
  agent-session attempt and is updated only from provider/network-shaped failure classifications,
  never from agent-code-quality or verification failures.
- `typecheck`, `format:check`, `lint`, `test` (108 passing: 17 new — 10 pure unit tests for
  budget/circuit-breaker math and edge cases including the "failed HALF_OPEN probe must reset the
  cooldown, not retry immediately" case; 5 new RunService integration tests proving the wiring
  actually works end-to-end — refuses to start on an exhausted HARD budget, stops repairing on
  mid-run exhaustion without upgrading trust, ADVISORY never blocks, unconfigured budget stays
  fully permissive, and a circuit that opens during one run genuinely refuses the next run's first
  attempt without ever calling the broken agent again), `build`, `compose:check`, `smoke` — PASS.
- Found and fixed one unrelated latent bug while validating: `NativeCliAdapter.updatePolicy`
  (and implicitly `send`) could crash the whole process with an unhandled `EPIPE` error *event* on
  a child's stdin stream (write-after-exit), which a synchronous `try/catch` around `.write()`
  cannot catch — this is a stream-level async error, not a thrown exception. Fixed by attaching a
  swallowing `'error'` listener to the stdin stream at session start; there is nothing actionable
  left to do once the child has already exited. Verified stable across repeated full-suite runs
  before and after the fix.
- Fresh-context review (independent subagent, diff-only, no primed conclusion) found 5 MATERIAL
  issues, all fixed before commit —
  1. **Circuit breaker could be permanently wedged open.** `beginAttempt()` consumed the single
     HALF_OPEN probe slot, but the slot was only ever released by `recordOutcome()`, which was
     only called for provider-related failure classifications. A probe that failed for any OTHER
     reason (e.g. `AGENT_FAILURE`) left `halfOpenTrialInFlight` permanently `true` — a process-wide,
     self-inflicted denial of service for that provider until restart, since one breaker instance
     is shared across all runs. Fixed by adding `releaseProbe()`, called whenever an attempt's
     outcome isn't provider-health-relevant, so the slot is always resolved one way or the other.
     Proven by a unit test that first reproduces the exact wedge (no release call at all → stuck
     forever) and a second test proving `releaseProbe()` fixes it.
  2. **The "recovery" budget category never reflected real spend.** Only `run.cost.model` was ever
     incremented (from agent-reported cost); `run.cost.recovery`/`retry` stayed 0 forever, so the
     recovery-retry budget gate could only ever fire from a *static* zero allocation, never from
     actually accumulated retry cost. Fixed by threading a cost category through the attempt
     pipeline: the first attempt in a governed session is "execution"; any further attempt within
     the same call is a bounded recovery retry and its reported cost now lands in
     `run.cost.recovery`. Proven by an integration test with a "fails once, succeeds on retry"
     fixture scenario asserting the retry's cost lands in `cost.recovery`, not `cost.model`. (The
     "verification" category is deliberately never gated — CommandVerifier is genuinely $0 today,
     and M4C requires verification to never be skippable for budget reasons in the first place;
     this is now an explicit code comment at the call site rather than an unexplained absence.)
  3. **A budget-denied recovery retry mislabeled the capsule's recovery reason.** The code
     re-threw the *original* underlying error (e.g. a transient failure) rather than indicating
     budget was the actual reason no further retry happened, so `RecoveryCapsule.recoveryReason`
     showed the original failure's classification instead of `BUDGET_EXHAUSTED`. Fixed by throwing
     a `BudgetExhaustedError` (preserving the original error's text and classification in its
     message) specifically when budget — not attempt count, not non-retryability — is what stopped
     the retry. Also fixed `buildRecoveryCapsule`'s `remainingBudget`, which was hardcoded to
     `null` unconditionally even when a budget was configured; now computed from the actual
     allocation and spend at capsule-capture time. Proven by an integration test asserting
     `recoveryReason === "BUDGET_EXHAUSTED"`, the original classification preserved in
     `recoveryDetail`, and `remainingBudget` being a real number.
  4. **Agent-reported cost was trusted with no bounds.** `costUsd` is fully agent-controlled data;
     with no validation, a negative value could drive spend below zero (permanently bypassing a
     HARD budget for that direction), and an absurd value could force an immediate self-inflicted
     pause. Fixed with `sanitizeReportedCost` (negative, non-finite, or over a $1,000
     single-event ceiling is rejected — never applied, never clamped to a different number — with
     an honest `ImplausibleCostIgnored` event). Documented as a partial mitigation only: it cannot
     stop an agent that always under-reports near zero, which would require independent metering
     out of scope for this milestone — stated explicitly in `ARCHITECTURE.md` rather than
     overclaimed. Proven by unit tests for the sanitizer and an integration test asserting an
     implausible value is ignored and `cost.model` stays untouched.
  5. **`ARCHITECTURE.md` overclaimed the circuit breaker's real-world reach.** Because M3's
     `AgentReportedFailure` always classifies agent-reported errors as `AGENT_FAILURE` (never a
     provider category), a real provider outage a CLI-spawned native agent absorbs internally and
     reports as its own failure never reaches the breaker — it is only genuinely exercised by
     harness/adapter-level throws (e.g. `agent.start()` itself failing) in today's single-adapter
     reality. Added an explicit "honest applicability" paragraph rather than letting the section
     read as though it protects against real CLI-agent-absorbed provider outages today.
- Re-validated after fixes: `typecheck`, `test` (118 passing), `format:check`, `lint`, `build`,
  `compose:check`, `smoke` — all PASS.

## M5 design (Task Risk Profiler and Assurance Planner)

Confirmed starting point: `qualityPreference` already exists as a UI-only display string
(`ProjectPreferences.qualityPreference` in `src/application/project-registry.ts`) — never wired to
`Task`/`Run`, never consulted anywhere. This is the exact "displayed, not enforced" gap M5A closes,
mirroring M4's budget gap.

Scope for this pass (deliberately bounded — M5 profiles risk and plans assurance; the actual
security/performance/architecture verifiers the plan calls for are M7–M9's job, not built yet):
1. `src/domain/risk.ts`: `RiskDimension` (the ten dimensions from the roadmap: ReasoningDifficulty,
   CodeCoupling, BlastRadius, ArchitectureSensitivity, DebtRisk, SecuritySensitivity,
   PerformanceSensitivity, OperationalSensitivity, NetworkBoundaryChanges, DataConsistencyRisk), a
   `RiskVector` (one `{level, provenance, evidence}` per dimension — never collapsed into a scalar),
   and `deriveRiskVector(evidence)` — deterministic path-pattern and module-graph rules (reusing
   M2's `moduleOwnership`/`packageOwnership`/relations), never a model call. Dimensions without
   reliable deterministic evidence today (`DebtRisk` — M7A doesn't exist yet; `ReasoningDifficulty`
   — genuinely not knowable ahead of time) are honestly `LOW`-confidence/`HEURISTIC` or explicitly
   marked insufficient evidence, never fabricated as confident.
2. `Task.qualityPreference?: "FAST"|"BALANCED"|"HIGH"|"CRITICAL"` (M5A), defaulting to `BALANCED`.
   Wired through `CreateRunRequest` the same way M4's `budget` field was.
3. `src/domain/assurance.ts`: `AssuranceCheck` (`CORRECTNESS`, `INTEGRATION`, `ARCHITECTURE`,
   `SECURITY`, `PERFORMANCE`, `CONCURRENCY`, `RESILIENCE`, `INDEPENDENT_REVIEW`) and
   `buildAssurancePlan(riskVector, qualityPreference)` — a deterministic rule table (not every
   check for every task) that also records, per check, a human-readable reason it either IS or is
   NOT required, satisfying the "explain what will be checked, why, and what is not required"
   requirement directly in the data structure.
4. `RunService` computes risk/assurance twice: once from the context builder's selected
   `initialFiles`/`initialModules` right after context is built (a pre-execution estimate — the
   only thing available before any diff exists), and again from the actual `candidate.diff` once a
   candidate exists (ground truth, refining the estimate). Both are emitted as `RiskProfiled` /
   `AssurancePlanned` events so the plan is inspectable evidence, not a hidden internal value.
   Wiring the plan into actual verification gates is explicitly M6–M10's job — this milestone does
   not add new gates, only the evidence-backed decision of what a future gate should check.

## M5 validation log

- `src/domain/risk.ts` (pure): `RiskDimension`/`RiskLevel`/`RiskProvenance`/`RiskValue`/
  `RiskVector`/`RiskEvidenceInput`/`deriveRiskVector`/`countCrossModuleEdges`. `src/domain/
  assurance.ts` (pure): `QualityPreference`/`AssuranceCheck`/`AssurancePlan`/`buildAssurancePlan`.
  Neither ever calls a model; both are pure functions of their inputs.
- `Task.qualityPreference` and `CreateRunRequest.qualityPreference` wired through the same optional,
  omit-when-absent pattern M4's `budget` field used; `src/server/app.ts`'s `createRunSchema` gained
  a matching `qualityPreference` zod field.
- `RunService.assessRisk` computes and emits `RiskProfiled`/`AssurancePlanned` twice per run: once
  right after `ContextBuilt`, from `context.initialFiles` against the enriched snapshot (pre-execution
  estimate); again from `captureCandidate`'s actual `diff.changedFiles` (ground truth), skipped only
  when a diff touches nothing. `crossModuleEdgeCount` is computed from the live snapshot's
  `relations`/`moduleOwnership` at each call, not cached from context-build time, so the
  diff-captured pass reflects any graph growth since.
- `typecheck`, `format:check`, `lint`, `test` (137 passing: 16 new pure unit tests for
  risk/assurance — deriveRiskVector always returns all ten dimensions, honestly marks
  ReasoningDifficulty/DebtRisk as INSUFFICIENT_EVIDENCE, flags security/data-sensitive paths
  DETERMINISTIC, marks unmatched path-pattern dimensions HEURISTIC rather than falsely confident,
  buildAssurancePlan requires INDEPENDENT_REVIEW only at HIGH security + CRITICAL preference,
  explains every check whether required or not, is deterministic for identical inputs; 3 new
  RunService integration tests — a security-path-scoped task produces a DETERMINISTIC-provenance
  HIGH SecuritySensitivity pre-execution estimate and a plan requiring SECURITY with a reason
  mentioning "auth"; the diff-captured refinement genuinely differs from the pre-execution estimate
  when the actual diff touches different files (proves the two-stage design is real, not the same
  value emitted twice); qualityPreference defaults to BALANCED when omitted and threads CRITICAL
  through to both the event data and the resulting plan), `build`, `compose:check`, `smoke` — PASS.
- Fresh-context review (independent subagent, diff-only plus full-repo read access, no primed
  conclusion; it independently executed `deriveRiskVector`/`buildAssurancePlan` with crafted inputs
  rather than only reading code) found 2 MATERIAL and 1 MINOR issue, all fixed before commit —
  1. **`CodeCoupling`/`BlastRadius`/`ArchitectureSensitivity` claimed `DETERMINISTIC` even when the
     touched files had zero coverage in `moduleOwnership`/`packageOwnership`.** Those maps only
     cover files M2's indexer actually parses as source (`isSourceFile` in `project-brain.ts`) — a
     migration `.sql`, Dockerfile, or CI workflow path is legitimately absent from both, not merely
     "0 modules". A migration- or infra-only diff was getting a confidently `DETERMINISTIC` "LOW
     coupling/architecture risk" verdict that was actually "no visibility at all" — which then
     silently suppressed the `ARCHITECTURE`/`INTEGRATION` assurance checks for exactly the kind of
     change the profiler exists to flag. Fixed with a `coverageProvenance` helper: full ownership
     coverage stays `DETERMINISTIC`, partial coverage degrades to `HEURISTIC`, zero coverage
     becomes `INSUFFICIENT_EVIDENCE` — applied to `CodeCoupling`/`BlastRadius` (via
     module/package ownership respectively) and `ArchitectureSensitivity` (via module ownership,
     since its cross-module-edge evidence is only as good as that same coverage). Evidence text
     now states explicitly how many touched files have no ownership evidence when degraded. Proven
     by two new unit tests: a migration-only diff (zero coverage) marks all three
     `INSUFFICIENT_EVIDENCE`; a mixed source+migration diff (partial coverage) marks the module/
     package dimensions `HEURISTIC` rather than `DETERMINISTIC`.
  2. **`OperationalSensitivity` was computed with real deterministic evidence in `risk.ts` (docker/
     deploy/infra/CI path patterns) but never referenced anywhere in `buildAssurancePlan`** — unlike
     `ReasoningDifficulty`/`DebtRisk`, which are explicitly and honestly excluded, this dimension
     had zero effect on the resulting plan despite carrying real signal, silently wasting a
     dimension the profiler already computes correctly. Fixed by folding `OperationalSensitivity`
     into the `RESILIENCE` check's requirement (alongside `NetworkBoundaryChanges` and `CRITICAL`
     preference) with its own reason text — an operational/deploy-sensitive change is exactly the
     kind of change `RESILIENCE` (production-boundary failure modes) exists to catch. Proven by a
     new unit test: a `HIGH` `OperationalSensitivity` vector requires `RESILIENCE` with a reason
     mentioning "deploy".
  3. **MINOR:** two test titles in `tests/assurance.test.ts` overclaimed coverage — one titled
     "security and resilience" never asserted resilience; one titled "HIGH/CRITICAL quality
     preference" only ever exercised `CRITICAL`. Investigating the second surfaced a real,
     previously-untested behavioral asymmetry: a `HIGH` (not `CRITICAL`) preference alone expands
     only `INTEGRATION`, not `SECURITY`/`RESILIENCE` — deliberate (forcing every `HIGH`-preference
     task through a security check regardless of actual risk would defeat "a small, low-risk change
     gets a small plan"), but previously unverified by any test. Split into accurately-titled tests
     and added one asserting the `HIGH`-only behavior explicitly, plus a dedicated
     `OperationalSensitivity`-drives-`RESILIENCE` test for finding 2.
- Re-validated after fixes: `typecheck`, `test` (141 passing), `format:check`, `lint`, `build`,
  `compose:check`, `smoke` — all PASS.

## M6 design (Quality Governance)

Starting point: M5 left the assurance plan as inspectable evidence only — "wiring the plan into
actual verification gates is explicitly M6–M10's job". M6 is the first milestone that consults the
plan. Scope: quality vector + trust ladder + bounded independent review (M6A–M6F) plus
qualityPreference threading (M6G, delivered structurally in M5 via `Task.qualityPreference` and
the plan rule table — FAST/HIGH widen/narrow which checks the plan requires; they never bypass
CORRECTNESS or the HIGH-security+CRITICAL review rule).

1. `src/domain/quality.ts` (pure): `QualityCheckState` (`PASS`/`WARN`/`FAIL`/`UNKNOWN`/
   `NOT_REQUIRED`), `QualityProvenance` (`DETERMINISTIC`/`PENDING_CHECKER`), the eight
   `QualityDimension`s, and `deriveQualityReport(input)` → a `QualityReport` vector where every
   dimension always carries state + evidence + provenance — never collapsed to a scalar. Correctness
   is deterministic from the trusted verification state; Architecture is a deterministic scope-creep
   detector (diff-captured risk vs the pre-execution estimate); Maintainability is files touched
   outside the pre-execution scoped modules; TestQuality is source-without-test in the diff.
   Security/Performance/Resilience are honestly `UNKNOWN`/`PENDING_CHECKER` when plan-required
   (their checkers are M8/M9/M10); DebtDelta reuses M5's DebtRisk evidence (honest `UNKNOWN` until
   M7A).
2. `deriveTrustState(verificationState, report, plan, reviewApproved)` implements the M6A ladder:
   not-VERIFIED → `PROPOSED` regardless of anything a model says; a gated dimension that is not
   exactly PASS → `CORRECTNESS_VERIFIED`; review required but not approved → `QUALITY_VERIFIED`;
   otherwise `MERGE_ELIGIBLE`. `DURABLE_VERIFIED` is in the type but unreachable until M10.
3. Gating decision (explicit): gated dimensions are only those with a checker that exists today —
   Correctness and Architecture. Security/Performance/Resilience are reported (UNKNOWN, never PASS)
   but do not gate until their milestone checkers land: an unbuilt checker must neither deadlock
   `MERGE_ELIGIBLE` for every security-adjacent change for three milestones nor silently pass
   anything. When each checker lands, its dimension joins `gatedDimensions` and gating activates
   with no other change.
4. `src/domain/review.ts` (pure): `buildReviewPrompt` (requirements, bounded diff preview, verdict
   file contract, explicit denial of author-side contamination such as the author's confidence) and
   `parseReviewVerdict(raw, {candidateId, diffDigest})` — malformed JSON, wrong shape, or a verdict
   echoing a different candidateId/diffDigest is `INVALID`, never a promotion.
5. `RunService.assessQuality` runs after final diff capture, driven by the diff-captured assessment
   (ground truth, not the pre-execution estimate). If that plan requires `INDEPENDENT_REVIEW`, it
   starts one fresh-context reviewer session (no credentials, bounded single attempt, gated by M4's
   provider circuit breaker) whose verdict file is written after the candidate diff was captured, so
   the verdict itself never contaminates the diff under review. Reviewer usage/cost is accounted to
   the run. Verdict + report + trust state are emitted as `IndependentReviewRequested`/
   `IndependentReviewCompleted`/`QualityAssessed` events; `RunCompleted` carries `trustState`.
   A non-VERIFIED candidate never reaches quality assessment at all: it stays `PROPOSED` and no
   model review is consulted.

## M6 validation log

- `tests/quality.test.ts` (unit, pure): report always contains all eight dimensions with evidence +
  provenance; UNKNOWN-not-PASS for required-but-checkerless Security (M8 evidence text) and
  Resilience; NOT_REQUIRED carries the plan's reason; Correctness FAIL on non-VERIFIED; Architecture
  WARN on grown footprint / PASS within estimate; TestQuality WARN/PASS; DebtDelta UNKNOWN reusing
  DebtRisk evidence; Maintainability WARN out-of-scope. Trust ladder: PROPOSED despite approved
  review when not VERIFIED; MERGE_ELIGIBLE low-risk; UNKNOWN-without-gating reaches MERGE_ELIGIBLE
  with approval; WARN caps at CORRECTNESS_VERIFIED; QUALITY_VERIFIED when review required but not
  approved; MERGE_ELIGIBLE only on approval; DURABLE_VERIFIED never returned. Fixture sanity tests
  pin the HIGH-security + CRITICAL plan semantics.
- `tests/review.test.ts` (unit, pure): prompt binds candidateId/diffDigest, contains requirements/
  diff/verdict contract and the contamination denial; parse: APPROVED with echo, REJECTED, INVALID
  for undefined/malformed/wrong-shape/wrong-candidateId/wrong-diffDigest; non-string reasons → [].
- `tests/quality-governance.integration.test.ts` (8 tests, real NativeCliAdapter + sandbox):
  low-risk verified candidate → MERGE_ELIGIBLE with full vector, no review, DebtDelta UNKNOWN;
  verification failure → PROPOSED with no `QualityAssessed`/`IndependentReviewRequested` events;
  HIGH-security (fixture agent genuinely edits three auth files, so the diff-captured assessment is
  the ground-truth driver) + CRITICAL → review requested; approve → MERGE_ELIGIBLE with Security
  UNKNOWN/PENDING_CHECKER and an identity-bound verdict; reject/malformed/wrong-candidate/session-
  failure → QUALITY_VERIFIED; TestQuality WARN never blocks.
- Full suite after implementation: `format:check`, `lint`, `typecheck`, `test` (178 passing),
  `build`, `compose:check`, `smoke` — all PASS.
- Architecture-WARN promotion-capping is covered at unit level only: the fixture diff edits files
  inside the already-scoped auth module, so the integration fixture cannot grow cross-module
  coupling without inventing a scenario the harness never runs. Unit tests
  (`quality.test.ts` "caps at CORRECTNESS_VERIFIED") cover the gate directly.
- Fresh-context review (independent subagent, diff-only plus full-repo read access, no primed
  conclusion; it independently executed the pure functions with crafted inputs and ran the test
  suite) confirmed the core contract — ladder precedence, candidate/digest binding, deterministic-
  over-model precedence, UNKNOWN honesty, single bounded review attempt, circuit-breaker gating —
  and found 3 MATERIAL and 8 minor issues. MATERIAL, all fixed before commit:
  1. **Cancel during independent review resurrected the run as COMPLETED/VERIFIED.** The catch in
     `runIndependentReview` swallowed the cancellation error thrown by the reviewer event loop and
     converted it to an INVALID verdict; execution then fell through to the unconditional
     `run.state = "COMPLETED"`, overwriting the CANCELLED state `cancel()` had already persisted.
     Pre-M6 the window between final verification and completion was microseconds; the reviewer
     session made it minutes wide. Fixed: the catch rethrows when `active.get(run.id)?.cancelled`,
     so cancellation propagates to the outer handler and the run stays CANCELLED.
  2. **The reviewer approved a digest of a diff it never fully saw.** The patch was sliced to
     `maxDiffPreviewChars` (12k) with no truncation marker, so an APPROVED verdict echoed the
     sha256 of the FULL patch while the reviewer examined only the first 12k chars — routine
     real-world changes get merge eligibility signed off on partial evidence with no signal
     anywhere. Fixed: the truncated prompt now ends with an explicit `[TRUNCATED: ...]` marker
     instructing the reviewer to reject if the cut-off portion could affect the verdict, and
     `IndependentReviewRequested` carries `diffTruncated: true`.
  3. **Reviewer sandbox tampering went undetected.** The reviewer's only write constraint was
     prose; nothing re-checked the workspace after the session, so a buggy or adversarial reviewer
     could rewrite any file after the candidate diff was captured — and a VERIFIED run's sandbox is
     retained, so the tampered state is what a human would later inspect. Fixed: after the verdict
     file is read it is deleted and the diff re-collected; a digest mismatch with the candidate
     under review makes the verdict INVALID ("workspace changed during independent review") and
     promotion is withheld. Proven by a new integration test (`review verdict: tamper` fixture
     marker: a well-formed APPROVED verdict plus a post-capture file edit → INVALID +
     QUALITY_VERIFIED).
  Minor fixes in the same pass: (4) a verdict with missing/empty/non-string[] `reasons` is now
  INVALID (an unjustified approval is not a valid verdict) — previously it was accepted as APPROVED
  with `reasons: []`; (5) the test that overclaimed this behavior now asserts INVALID; (6) the
  quality report is now derived BEFORE the reviewer session starts, and the review is skipped with
  a recorded `reviewSkipped` reason when a gated dimension already caps promotion at
  CORRECTNESS_VERIFIED — no more review spend that cannot affect the outcome; (7) a failed reviewer
  session's `IndependentReviewCompleted` now carries provenance REVIEWER_SESSION_FAILED, not
  MODEL_REVIEW (no model was consulted); (8) Maintainability now discloses changed files with no
  module ownership evidence (new files) in its evidence rather than silently counting them
  in-scope. Not fixed, judged acceptable as-is: reviewer mode-selection lives in the fixture
  (test infra only); the reviewer session is not policy-enforced (it only reads); TestQuality
  counts any test file in the diff (informational, ungated).
- Re-validated after fixes: `format:check`, `lint`, `typecheck`, `test` (179 passing), `build`,
  `compose:check`, `smoke` — all PASS.

## Blockers

- None.

## Deferred work

- Real-agent smoke (`npm run real-agent:smoke`) requires an authenticated Claude Code CLI; will run
  only if available and bounded.
