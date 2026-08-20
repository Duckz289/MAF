# MAF v1 completion program

Canonical ledger for the M1–M15 roadmap that evolves MAF from an adaptive-agent harness into an
adaptive software-engineering control plane. Decisions and evidence only; no hidden reasoning.

## Program state

- Start branch: `adaptive-harness/runtime-signals-v0.1` at `357ab60` (clean tree).
- Baseline validation (2026-08-19): `format:check`, `lint`, `typecheck`, `test` (49 passing),
  `build` (server + UI), `compose:check`, `smoke` — all PASS.
- Current milestone: M11 — Codebase Health Ledger (M10 committed locally).

## Confirmed repository facts

- M1 now separates desired from effective mode and enforces transitions through acknowledged live
  updates or bounded session boundaries; an unenforced desired mode is never reported as effective.
- M2 now performs a full path-only inventory with an honest 100 000-file safety ceiling and a
  bounded digest-aware scoped parse. Runtime observations receive the incrementally grown graph.
- M3 persists recovery capsules, preserves candidate-lineage metadata, bounds new-session retries,
  refuses stale/unknown revision resumes, and provides an evidence-preserving emergency stop.
- M4–M7 add budget authority, deterministic risk/assurance planning, candidate-bound quality
  governance, bounded independent review, debt delta, and architecture-layer checks.
- M8's deterministic security checker and unconditional Security FAIL gate landed at `07337bc`;
  the independently reproduced global-RegExp state leak and the wider persistence/unknown-state
  boundary were repaired at `539f000`. Two fresh-context reviews and composed API/storage tests
  now support VERIFIED status; the bounded pattern matcher is not represented as universal DLP.
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
| M7 | Architecture governance + debt delta | DONE (VERIFIED) | 48fbfde |
| M8 | Security assurance (8A–8B) | DONE (VERIFIED) | 07337bc + 539f000 |
| M9 | Performance & runtime assurance | DONE (VERIFIED) | 461a33d |
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

## M7 design (Architecture Governance and Technical Debt)

Starting point: M6 left `DebtDelta` honestly UNKNOWN (`PENDING_CHECKER`) and `DebtRisk`
`INSUFFICIENT_EVIDENCE`, with the documented contract "when each checker lands, its dimension
joins `gatedDimensions` and gating activates with no other change." M7 lands both checkers the
plan already knew how to require. Scope: M7A declared-debt delta checker + M7B deterministic
layering rule, both reading the candidate's own unified diff.

1. `src/domain/diff-parse.ts` (pure): `parseFilePatches(patch)` — a minimal unified-diff parser
   producing per-file added/removed lines. Git-shaped headers only (quoted, `/dev/null`, or
   `a/`/`b/`-prefixed) so source content that begins with `--`/`++` cannot impersonate a header; a
   deleted file (`+++ /dev/null`) keeps its entry via the preceding `--- a/<file>` header so its
   removed lines still count (a deleted file's markers ARE removed debt).
2. `src/domain/debt.ts` (pure, M7A): `deriveDebtDelta(patch)` counts word-bounded declared-debt
   markers (`TODO`/`FIXME`/`HACK`/`XXX`) in added vs removed lines of source files only. Net ≤ 0
   PASS, 1–4 WARN, ≥ `DEBT_FAIL_THRESHOLD` (5) FAIL — a rewrite that defers five new TODOs is
   debt-accumulation-by-another-name. Removed markers offset added ones: paydown is real.
3. `src/domain/architecture.ts` (pure, M7B): `deriveArchitectureGovernance(patch)` enforces the
   layering rule implied by M2's module convention (`src/<layer>`): a `src/domain` file's ADDED
   import resolving outside `src/domain` inverts the dependency direction → FAIL with one
   violation per offending import. Catches `from`-clause, side-effect `import "..."`, dynamic
   `import(...)`, and `require(...)` forms; comment lines are skipped so prose mentioning a path
   cannot fabricate a violation. Non-relative (package/builtin) imports unconstrained; layers
   above domain unconstrained (application→infrastructure is legitimate); removed lines are not
   analyzed — only added imports can introduce a violation.
4. `src/domain/risk.ts`: `DebtRisk` gains the diff-captured inputs. When `debtMarkers` is provided
   (only at the diff-captured stage — no diff exists pre-execution) it is DETERMINISTIC (net ≥ 5
   HIGH, ≥ 2 MEDIUM, else LOW); pre-execution stays honestly INSUFFICIENT_EVIDENCE.
5. `src/domain/assurance.ts`: new `DEBT` check — required when DebtRisk ≥ MEDIUM or the preference
   is HIGH/CRITICAL, with the usual always-present reason.
6. `src/domain/quality.ts`: `DebtDelta` joins `gatedDimensions` (→ `DEBT`) — exactly the M6
   contract, gating activated with no other change. Architecture now runs governance first: a
   layering violation is reported as FAIL whether or not the plan required ARCHITECTURE (a broken
   rule is evidence, not a preference) but gating still follows the plan's decision, per M6's
   plan-gating contract. Both checkers analyze the real patch (`diffPatch` input, wired in
   `RunService.assessQuality`); `captureCandidate` computes the marker counts once from the real
   diff and feeds them to the diff-captured risk assessment, so the plan and the DebtDelta result
   can never disagree (same `deriveDebtDelta` source, same patch).
7. Fixture (`src/fixtures/native-agent.ts`): "introduce debt" marker appends two TODOs to a real
   source file, so integration tests exercise a genuinely non-zero debt delta.

## M7 validation log

- `tests/debt.test.ts` (unit, pure, 8 tests): PASS/WARN/FAIL thresholds, paydown net −2, non-source
  ignored, word-boundary (`TODOS` ≠ marker), empty patch, deleted-file markers counted as removed.
- `tests/architecture.test.ts` (unit, pure, 10 tests): FAIL for `../application`/
  `../infrastructure`/`../../application`; PASS for in-domain relative, package, and builtin
  imports (only relative counted); application→infrastructure unconstrained; non-source ignored;
  removed-lines-only PASS; side-effect/`require()`/dynamic-import forms all FAIL (no from-clause
  bypass); comment prose mentioning a path does not fabricate a violation; parser multi-file
  attribution; `--`/`++`-prefixed content lines not mistaken for headers; deleted-file attribution.
- `tests/risk.test.ts`, `tests/assurance.test.ts`, `tests/quality.test.ts` (updated): DebtRisk
  deterministic from markers (LOW/MEDIUM@2/HIGH@5 with net evidence); DEBT plan requirement at
  MEDIUM or HIGH/CRITICAL preference; DebtDelta deterministic PASS/WARN and gated WARN capping at
  CORRECTNESS_VERIFIED; layering FAIL reported even when ungated.
- `tests/quality-governance.integration.test.ts` (end-to-end): the fixture agent genuinely adds
  two TODOs → DebtRisk MEDIUM/DETERMINISTIC at the diff-captured stage, DEBT plan-required,
  DebtDelta WARN, trust capped at CORRECTNESS_VERIFIED; low-risk runs now report DebtDelta
  PASS/DETERMINISTIC (previously UNKNOWN).
- Full suite: `format:check`, `lint`, `typecheck`, `test` (202 passing), `build`, `compose:check`,
  `smoke` — all PASS.
- Fresh-context review (independent subagent, working-tree diff plus full-repo read access; it
  independently executed the pure functions with crafted probe inputs before reporting) confirmed
  the gating contract (FAIL always reported, gating plan-bound), threshold consistency between
  DebtRisk and DEBT_FAIL_THRESHOLD, run-service wiring, and CRLF/multi-file/resolution edge cases.
  Found 1 MATERIAL and 5 minor issues, fixed before commit:
  1. **MATERIAL — layering rule bypassable via side-effect imports and `require()`.** The
     specifier regex only matched `from "..."` and `import(...)` forms, so
     `import "../application/register-side-effects";` produced a silent PASS over a real
     domain→outer-layer dependency — a violation of the checker's own one rule and of "never claim
     verification you didn't perform". Fixed: the regex now catches from-clause, side-effect,
     dynamic-import, and require forms, with comment lines excluded; regression tests cover all
     four forms plus the comment false-positive.
  2. **Deleted files' removed lines were dropped** (`+++ /dev/null` discarded the entry), so a
     deleted file full of TODOs counted as zero removed markers, and a deletions-only patch
     produced the false evidence "no source files changed". Fixed via `---`-header attribution
     (above); regression tests cover both.
  3. **A removed source line starting with `-- ` could be mistaken for a `--- a/...` header.**
     Fixed by requiring the header shape (quoted/`/dev/null`/`a|b/`-prefixed) for both headers.
  Minor, judged acceptable as-is: (4) a `from "..."` inside a mid-line string literal in real code
     could still match (comment lines are excluded; the innermost statement-level form is not
     parsed — the checker is a diff heuristic over added lines, not a TypeScript parser); (5) an
     added line whose content itself begins with `++ a/b/...`-shaped text could impersonate a
     header (not reachable from the harness's own git diffs); (6) space-separated timestamps in
     `+++` headers would corrupt the filename (git uses tab/no timestamp).
- Re-validated after fixes: `format:check`, `lint`, `typecheck`, `test` (207 passing), `build`,
  `compose:check`, `smoke` — all PASS.

## M8 repair design (Security Assurance)

Starting point: commit `07337bc` had the intended deterministic secret-leak gate and persistence
redactor, but `redactPatchPreview` called `.test()` on a shared global regular expression. A focused
regression using two consecutive private-key files failed before the fix: `RegExp.lastIndex` state
made suppression depend on call order and retained one unsigned PEM body in the durable preview.

1. All test/search expressions are stateless per call. Structured formats cover permanent and STS
   AWS access-key IDs, GitHub/Slack tokens, and complete private-key blocks including encrypted
   PKCS#8. Generic matching covers common quoted/template, env/config namespace, Go `:=`, and YAML
   block-scalar assignment forms. Findings never contain the matched literal.
2. Patch previews suppress every added line of a credential-bearing file. Reversible binary patch
   bodies are removed. Binary, gitlink, and rename/copy-only destinations are `NOT_CHECKED` because
   their complete bytes are absent from the textual diff; a required Security check therefore
   blocks rather than becoming a synthetic PASS.
3. The same recursive sanitizer now covers stored task text, run errors/changed paths, verifier
   command/output, direct controller-created mode events, runtime-signal snapshots, recovery text
   and locators, repair/reviewer prompts, artifacts, and API/SSE values. Secret-shaped execution
   locators are rejected before persistence. Reference-shaped keys preserve only validated,
   secret-free `credential://` locators or known capability labels.
4. Exact candidate/digest binding and deterministic precedence are unchanged: a Security FAIL gates
   promotion regardless of plan selection or model approval; `NOT_CHECKED` never becomes PASS.

## M8 repair validation log

- Pre-fix reproduction: consecutive private-key persistence regression failed against `07337bc`,
  proving the global-RegExp `lastIndex` leak rather than inferring it from source alone.
- Focused/unit/integration coverage now exercises adjacent and encrypted PEMs, repeated and
  namespaced assignments, spaced/template passphrases, Go/YAML forms, AKIA/ASIA identifiers,
  Git-quoted UTF-8 binary paths, binary/gitlink/rename unknown states, raw verifier/failure text,
  mode evidence, invalid reference exemptions, recovery locators, and adversarial filenames across
  actual RunService, store, artifact, telemetry, recovery, HTTP, runtime-signal, and SSE boundaries.
- First fresh-context review found four MATERIAL classes: incomplete credential forms, binary PASS
  plus reversible payload retention, raw verifier persistence, and raw task/run/recovery fields.
  All were repaired and regression-tested.
- Second fresh-context adversarial review found additional reachable retention forms and boundary
  exceptions (mode-event direct append, reference-key trust, locators/filenames/snapshots, quoted Git
  paths, config namespaces and assignment syntaxes, gitlinks/renames). After fixes, its final verdict
  was **no material findings remain**; the only minor limitation is intentionally pattern-based
  detection rather than universal entropy/DLP coverage, accurately bounded in the security docs.
- Final post-review gate: `format:check`, `lint`, `typecheck`, `test` (252 passing), `build`,
  `compose:check`, and `smoke` — all PASS. No dependency or schema change; audit/migration smoke was
  not applicable. Repair commit: `539f000`.

## M9 design (Performance and Runtime Assurance)

1. `derivePerformanceSensitivity(files, patch?)` (src/domain/performance.ts) — diff-scan of added
   non-comment production lines across 9 signal kinds (DB_QUERY, PAGINATION, SCHEMA_INDEX,
   NETWORK_CALL, LARGE_PAYLOAD, BUNDLE, HOT_LOOP, SERIALIZATION, MEMORY). With a patch the
   provenance is DETERMINISTIC; without one, path heuristics only, provenance HEURISTIC. Signals
   are calibrated strong/weak: a single ubiquitous weak signal (one `JSON.parse`, one `.limit(`)
   stays LOW and cannot force a required measurement; SQL text, DDL, network calls, and
   bundle/hot-path markers are strong. Removals of DB_QUERY/PAGINATION/SCHEMA_INDEX lines count
   as evidence too — deleting a `.limit(10)` or a `DROP` of an index is the archetypal regression
   and added-lines-only scanning would miss it. It feeds RiskVector.PerformanceSensitivity.
2. `deriveRuntimeGraph(patch)` (src/domain/runtime-graph.ts) — deployment topology, deliberately
   separate from the M2 source Project Graph. Nodes are created only from content evidence: SQL
   statement shapes, `prisma.`/`sequelize`/`typeorm`, named cache/object-storage technologies
   (redis/memcached, s3/object storage), `fetch`/`axios`/explicit "external api" text, or
   migration/`.sql`/`.prisma` paths. Filenames and generic identifiers (`cache.ts`, a local
   `Map`, `fs.writeFile`, a variable named `database`, an inbound `webhook` route) do not
   fabricate topology. SERVICE vs EXTERNAL_SERVICE follows the ownership rule: fetch/network
   evidence alone yields SERVICE; only code that itself identifies an external API yields
   EXTERNAL_SERVICE. Unknown edge attributes (timeoutMs, retryPolicy, authenticationBoundary,
   rateLimiting, payloadBehavior, consistencyAssumption) stay null and are surfaced as explicit
   unknowns. Emitted as a `RuntimeGraphDerived` event bound to candidateId + diffDigest.
3. `CommandPerformanceVerifier` (src/infrastructure/performance-verifier.ts) — measures the same
   bounded command against a clean-source baseline worktree and the candidate sandbox (median of
   ≤10 samples; last stdout line parsed as a number or `{value}`). A dirty source repository, a
   baseline revision mismatch with candidate HEAD, command failure, or non-numeric output yields
   NOT_CHECKED, never a synthetic PASS. Baseline worktree teardown failure (e.g. Windows file
   locks) does not invalidate a completed measurement.
4. `derivePerformancePosture(measurement, expectedCandidateId, expectedDiffDigest,
   maxRegressionPercent)` — the measurement must be bound to the current candidate id and diff
   digest, MEASURED, non-empty, with finite non-zero baselines and finite candidates; otherwise
   NOT_CHECKED. Regression over threshold → FAIL. In run-service, the diff is re-collected after
   measurement and a digest change invalidates the result (NOT_CHECKED).
5. Quality gate: Performance joined the gated dimensions. A plan that requires PERFORMANCE with
   no candidate-bound measurement produces a deterministic NOT_CHECKED that caps the run at
   CORRECTNESS_VERIFIED (new operationalStatus ASSURANCE_BLOCKED; QUALITY_VERIFIED awaiting
   review is now shown as AWAITING_REVIEW rather than blocked). Performance spec labels are
   sanitized with redactSensitiveText at the durable task boundary.

## M9 validation log

- Fresh-context independent review (post-implementation, reviewer not primed with correctness)
  returned 3 MATERIAL, 5 MINOR, 6 OBSERVATIONS:
  - MATERIAL 1 (over-blocking): a single added `JSON.parse`/`.query(` line forced MEDIUM →
    PERFORMANCE required → NOT_CHECKED block on mundane changes. Fixed by dropping `\.query\s*\(`
    from DB_QUERY and the strong/weak calibration above; regression-tested ("keeps a single
    ubiquitous weak signal (one JSON.parse) at LOW").
  - MATERIAL 2 (under-detection): removal-only diffs (deleting `.limit(10)` / a query) escaped
    added-lines-only scanning. Fixed by scanning removed lines for removal-sensitive kinds;
    regression-tested ("raises sensitivity when a diff removes query bounds or schema
    structure").
  - MATERIAL 3 (fabricated topology): filenames/identifier words (`cache.ts`, `upload`,
    `fs.writeFile`, a `database` variable) created CACHE/STORAGE/DATABASE nodes. Fixed by
    content-only signals; regression-tested ("does not fabricate CACHE/STORAGE topology from
    filenames or local in-memory/fs code") plus a positive named-technology test.
  - MINOR 5 (Windows worktree cleanup could invalidate a valid measurement): `rm` wrapped in
    catch. MINOR 7 (QUALITY_VERIFIED-awaiting-review displayed as ASSURANCE_BLOCKED): added
    AWAITING_REVIEW operational status (run-service, web types/badge/translation). MINOR 8
    (inbound `webhook` handler produced an outbound CALLS edge; browser branch matched the whole
    file instead of the external lines): both fixed and tested.
  - MINOR 4 (LocalWorktreeSandbox.digest used through the SandboxProvider abstraction): verified
    the digest is a pure sha256 of the patch text (semantically provider-neutral) — left as a
    layering note. MINOR 6 (stripped child env for npm-based commands) and OBSERVATIONS 11/12
    (baseline worktree lacks dependency bootstrap; RuntimeGraph is event-only with no consumer
    yet): left as documented limitations consistent with existing CommandVerifier parity; the
    graph is an M9 deliverable as evidence, and bootstrapping dependencies in baseline worktrees
    is unbudgeted wall time deferred to M10 where production-like resilience is in scope.
  - OBSERVATIONS 9/10 (model/verdict precedence, stale-evidence/NaN defenses) and the
    SERVICE/EXTERNAL_SERVICE ownership semantics were verified good by the reviewer.
- All 13 acceptance requirements from the handoff are covered by tests, including the positive
  EXTERNAL_SERVICE case (code that itself says "external api").
- Final gate: `format:check`, `lint`, `typecheck`, `test` (28 files, 279 passing), `build`,
  `compose:check`, `smoke` — all PASS.



## M10 design (Production-like Resilience)

1. `deriveResilienceRelevance(patch, concurrencyRequired)` (src/domain/resilience.ts) — which
   production-like failure scenarios THIS candidate owes, derived deterministically from the
   diff's added/removed non-comment production code only. Outbound dependency calls (fetch,
   axios, http(s) methods, grpc/graphql, redis/memcached, s3/sqs/sns/kafka/rabbitmq/amqp/mqtt,
   `WebSocket`, `new *Client(`, SQL text, `prisma.`) imply the network family: HIGH_LATENCY,
   TIMEOUT, CONNECTION_RESET, MALFORMED_UPSTREAM_RESPONSE, RATE_LIMITING. Consistency-critical
   write paths imply DUPLICATE_REQUEST; concurrent completion paths imply OUT_OF_ORDER_RESPONSE;
   a plan-required CONCURRENCY check forces the interleaving pair regardless of markers.
   Comments, fault-suggestive filenames/identifiers, and test/fixture/script paths are not
   evidence. A binary (GIT binary patch) hunk on an evidence-bearing path marks the relevance
   `uninspectable` — absence of a signal we could not look for is unknown, not empty, and fails
   closed to NOT_CHECKED rather than the zero-relevance PASS.
2. `CommandResilienceVerifier` (src/infrastructure/resilience-verifier.ts) — the trusted
   fault-injection boundary. Runs the project's own command once per relevant scenario in the
   candidate sandbox with `MAF_RESILIENCE_SCENARIO` set (the project's harness decides how the
   fault is injected; MAF never guesses). Optional `composeFile` brings up a bounded ephemeral
   environment (`docker compose up -d --wait`, 120s, torn down with `down -v --remove-orphans`);
   Docker Compose is the ceiling — no Kubernetes, by design. On Windows the command is suffixed
   with `; exit $LASTEXITCODE` because `powershell -Command` otherwise collapses every nonzero
   native exit code to 1 (found by the real-process tests; exit codes are scenario evidence).
3. `deriveResiliencePosture(measurement, candidateId, diffDigest, relevance)` — the measurement
   must be bound to the current candidate id and diff digest; the workspace digest is
   re-collected afterwards so mutation invalidates the evidence. Zero relevant scenarios is a
   deterministic PASS (unless uninspectable); missing spec/verifier, stale binding, an unexecuted
   or NOT_RUN relevant scenario is NOT_CHECKED; any FAILED scenario is deterministic FAIL; both
   gate promotion. Evidence states verbatim that local scenario execution is resilience evidence,
   not production verification.
4. Trust ladder: `DURABLE_VERIFIED` additionally requires plan-required RESILIENCE with MEASURED
   provenance and a PASS verdict — a heuristic relevance-empty PASS caps the rung at
   QUALITY_VERIFIED.
5. Cancellation: `ActiveRunState.verificationAbort` (AbortController) is aborted in `cancel()`
   and flows through `ResilienceVerifyInput.signal` into every subprocess (compose up/down and
   each scenario); `runProcess` escalates SIGTERM then a forced tree kill (taskkill /T /F on
   Windows) after 5s and resolves on exit+grace so orphaned grandchildren holding stdio pipes
   cannot hang the quality gate. A cancelled run stays CANCELLED and never emits RunCompleted.

## M10 validation log

- Real-subprocess verifier tests (tests/resilience-verifier.test.ts) pin the contract the design
  rests on: `MAF_RESILIENCE_SCENARIO` actually reaches the child (a typo in the env name cannot
  pass), exit codes survive the Windows shell (`; exit $LASTEXITCODE` fix), output tails become
  scenario evidence, timeouts bound execution (30s command, 1.5s timeout, FAILED with "timed
  out"), spec.scenarios allowlists filter execution, mid-sweep cancellation rejects within 10s
  (vs a 30s timeout), and a missing spec returns NOT_CHECKED without running anything.
- Domain tests (tests/resilience.test.ts): WebSocket/SDK-client dependency shapes count as
  network boundaries; a binary patch on a code path is uninspectable and never gets the
  relevance-empty PASS (a binary asset outside evidence paths does not); relevance, binding,
  missing/failed scenario gating, and honesty wording.
- Quality-governance integration tests: executed scenarios bind to the candidate (the
  performance fake must supply real metrics — empty metrics are NOT_CHECKED per M9);
  relevance-empty deterministic PASS caps at QUALITY_VERIFIED while a MEASURED scenario PASS
  promotes to DURABLE_VERIFIED when the plan requires RESILIENCE.
- process-utils hardening found necessary by testing: the minimal child env now passes through
  PATHEXT/SystemDrive — without PATHEXT, shell children cannot resolve node/.cmd shims and every
  scenario command died with CommandNotFoundException.
- Fresh-context independent review (post-implementation, reviewer not primed with correctness):
  REQUEST_CHANGES with MATERIAL B1 (heuristic blind spots — widened signal regexes,
  binary/uninspectable fail-closed, DURABLE_VERIFIED requires MEASURED provenance), M1 (a wedged
  subprocess could hang the gate — kill-tree escalation + exit-grace resolution), M2
  (cancellation did not reach in-flight scenario subprocesses — AbortController propagation),
  M3 (the real verifier was entirely untested — the real-process suite above). All fixed and
  tested. MINOR m2 (NOT_RUN treated as failure) now maps to NOT_CHECKED.
- Known/deferred (recorded, not fixed): m4 compose runs against the base repo path rather than a
  candidate-sandboxed compose file, and `composeFile` is not path-validated; m5 programmatic
  Tasks lack a timeout cap (spec.timeoutMs default 120s bounds scenarios, not the Task); m6 SQL
  `--` comment lines count as code evidence; m7 scenario output redaction is pattern-only tails;
  m8 gitignored mutations escape the digest re-check; m9 minor test nits.
- FRONTIER_REVIEW_RECOMMENDED (MAX reasoning effort): M10 production trust claims — the relevance
  heuristics and honesty gates are exactly the kind of evidence-boundary reasoning that benefits
  from an independent frontier pass.
- Final gate: `format:check`, `lint`, `typecheck`, `test` (30 files, 311 passing), `build`,
  `compose:check`, `smoke` — all PASS.

- None.

## Deferred work

- Real-agent smoke (`npm run real-agent:smoke`) requires an authenticated Claude Code CLI; will run
  only if available and bounded.
