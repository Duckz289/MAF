# Architecture

The harness is a modular TypeScript monolith. It deliberately wraps native coding agents instead
of replacing their planning, search, context management, or provider-specific capabilities.

```mermaid
flowchart LR
  API[Fastify control API] --> RUN[RunService]
  UI[Fluent UI dashboard] --> API
  RUN --> CORE[Domain policy]
  RUN --> AGENT[AgentAdapter]
  RUN --> SANDBOX[SandboxProvider]
  RUN --> BRAIN[ProjectBrain and RepositoryIndex]
  RUN --> VERIFY[VerifierPort]
  RUN --> TELEMETRY[TelemetrySink]
  RUN --> SIGNALS[RuntimeSignalCollector]
  RUN --> RECOVERY[Recovery plane: classify, capsule, pause, resume]
  RUN --> BUDGET[Budget authority + circuit breaker]
  AGENT --> ACP[ACP SDK]
  AGENT --> CLI[Native CLI]
  SANDBOX --> WORKTREE[Local Git worktree]
  BRAIN --> AST[ast-grep and deterministic map]
  API --> STORE[RunStore]
  STORE --> PG[(PostgreSQL)]
```

## Dependency rule

`src/domain` has no framework imports. `src/application` coordinates domain ports. Fastify,
PostgreSQL, Git, process execution, SDKs, and external HTTP services live under `src/infrastructure`
or `src/server`. This keeps use cases testable with in-memory adapters.

## Core run flow

1. `RunService` persists a task and a `PROPOSED` run.
2. `AdaptiveModeController` starts with `GUIDED` unless a mode was explicitly requested.
3. `LocalWorktreeSandbox` creates a detached Git worktree at the requested revision.
4. `RepositoryIndex` and `ProjectBrain` build a small task-specific context.
5. A capability-preserving `AgentAdapter` runs the native agent.
6. `RuntimeSignalCollector` updates evidence snapshots at context, tool-event, diff, and verification
   checkpoints; the controller may change mode without altering the agent's native planning loop.
7. The harness captures an attempt-linked candidate diff and artifact.
8. `CommandVerifier` moves the candidate through `VERIFYING`. A failure may start one bounded repair
   with structured verifier evidence; every new candidate and verification is persisted.
9. Only a trusted verifier pass moves output to `VERIFIED`; exhaustion remains `QUARANTINED`.
10. Telemetry records cost, tokens, retry, latency, mode, changed files, verification, and adaptive
   signal dimensions.
11. Worktree retention is applied and `SandboxFinalized` is emitted.

Downstream mission nodes can consume only `VERIFIED` outputs.

## Agent adapters

- `ACPAdapter` uses the official stable ACP TypeScript SDK over NDJSON stdio. ACP keeps its native
  streamed updates and session identity. File callbacks are constrained to the sandbox path.
- `NativeCliAdapter` runs any NDJSON-capable native CLI without normalizing away its planning or
  context loop.
- `ClaudeCodeAdapter` consumes Claude Code's native stream-json output and preserves reported usage,
  cost, tool events, and cancellation.
- `APIAgentAdapter` is the API-agent extension point.

The fixture agents prove the native CLI and ACP paths without external credentials.

## Adaptive modes

- `STRICT`: narrow deterministic execution after scope stabilization — bounded initial scope,
  minimal context, suited to mechanical known-scope work.
- `GUIDED`: default compact verified starting context with unrestricted native repository search.
- `SOLO_NATIVE`: coherent native investigation for uncertain or highly coupled work; MAF remains
  outside as observer/controller/verifier.

### Desired versus effective mode

A run tracks `desiredMode` (what the adaptive policy wants) separately from `effectiveMode` (what
is actually enforced on the current or next agent session). `executionMode` is a compatibility
mirror of `effectiveMode` and never shows unenforced desired state. Decisions are computed against
the desired mode; enforcement moves the effective mode only with evidence:

- `ModeChangeRequested` records intent with the planned enforcement strategy.
- `ModeChanged` records enforcement with `enforcement.method` and evidence.

Enforcement strategies (deterministic planner in `src/domain/policy-enforcement.ts`):

1. `SESSION_BOUNDARY` — no session is active; the next session starts under the new policy,
   with a context rebuilt for the new mode (`ContextRebuilt`).
2. `LIVE_UPDATE` — the agent declares `livePolicyUpdate`; the harness delivers a policy update to
   the running session and the mode becomes effective only after the session emits a matching
   `policy` acknowledgement event.
3. `SAFE_RESTART` — only for broadening transitions while a session is active, only when the agent
   declares `safeSessionRestart`, and bounded by `maxPolicyRestarts`; the session is restarted from
   the existing workspace with a rebuilt context and a continuation message.
4. `DEFERRED_BOUNDARY` — everything else; the change applies at the next safe execution boundary.
   Tightening transitions never restart a running session.

Every enforcement is a persisted `ModeChanged` event with `from`, `to`, `reason`, structured
evidence, enforcement method + evidence, the triggering signal-snapshot ID, evidence IDs, and
timestamp. Signals include dependency and context expansion, touched modules, resolved
cross-module import edges, changed files, verification failure history, uncertainty, scope
stabilization, and mechanical remaining work. `STRICT` is reversible when deltas from its entry
snapshot invalidate stabilization. Three observations of cooldown block immediate re-narrowing or
cumulative-signal escalation after a transition; explicit new evidence may still leave `STRICT`
immediately.

## Project Brain

`ProjectBrain` separates `FACT`, `INFERENCE`, `EVIDENCE`, and `DECISION`. A fact without evidence is
rejected. Records from a different source revision become `STALE`.
`OptionalCodebaseMemoryIndex` is an explicitly inactive optional port until a configured MCP/service
transport exists; its status exposes the deterministic local fallback and never claims a hidden
daemon connection.

## Project Graph: bounded incremental indexing

`RepositoryIndex.index()` is a cheap, unbounded, path-only pass — every tracked file (up to a
100 000-file safety ceiling, with an honest `filesTruncated` flag rather than a silent slice) plus
package/module ownership derived from paths alone. No file content is read, so it is safe to call
on every task regardless of repository size. `RepositoryIndex.indexScope()` performs the bounded,
expensive part — parsing symbols and resolved local `IMPORTS` relations for exactly the requested
files — and caches each file's parse by content digest so repeated calls during a run only do new
work for files that changed or were never seen before.

`RunService` selects an initial scope from the cheap snapshot (via `ContextBuilderPort`, using only
module/path data), scope-indexes exactly that scope, and re-renders the context with real symbols.
As the agent touches new files (tool events, diffs), `RunService` incrementally scope-indexes any
newly referenced files not yet parsed and grows the same snapshot instance; the enlarged snapshot
is threaded into subsequent `RuntimeSignalCollector` observations, so dependency-expansion and
cross-module-edge signals reflect real resolved relations for whatever has actually been touched,
never a frozen initial slice.

Package (`packageOwnership`) and architectural module (`moduleOwnership`) are tracked separately.
A package/workspace root (`workspaces`, simple pnpm workspace entries, `apps/*`, `packages/*`, and
`services/*`) is the outer unit; a `src/<layer>` or `src/features/<name>` convention within that
package forms a deeper architectural module (e.g. package `apps/web`, module
`apps/web/src/domain`), falling back to the package root when no such convention applies.
Relationship kinds stay deterministic: `IMPORTS` requires both a real resolved local specifier and
the target file to exist in the repository snapshot. Nothing derived from agent-claimed data is
ever labeled deterministic.

## Recovery plane

Failure may interrupt progress; it must not destroy trustworthy progress. `src/domain/recovery.ts`
is pure domain logic: `classifyFailure` deterministically pattern-matches an error against a
`FailureClassification` taxonomy (`PROVIDER_TRANSIENT`, `PROVIDER_DEGRADED`, `RATE_LIMIT`,
`NETWORK_FAILURE`, `CREDENTIAL_FAILURE`, `AGENT_FAILURE`, `VERIFICATION_FAILURE`,
`ENVIRONMENT_FAILURE`, `BUDGET_EXHAUSTED`, `USER_INTERRUPT`, `REVISION_CONFLICT`,
`UNKNOWN_FAILURE`), defaulting honestly to `UNKNOWN_FAILURE` rather than guessing. Only a narrow
set of classes (`PROVIDER_TRANSIENT`, `PROVIDER_DEGRADED`, `RATE_LIMIT`, `NETWORK_FAILURE`,
`AGENT_FAILURE`) are auto-retryable; everything else requires explicit resume or escalation.

`RunService` wraps every agent attempt in a bounded recovery loop: an auto-retryable failure gets
one new bounded session (never a resume into the session that just failed) up to
`maxRecoveryAttempts` per run. Anything that exhausts retries, or is not auto-retryable, propagates
to `execute()`'s outer catch, which builds a `RecoveryCapsule` — run/task identity, goal, base and
resolved revision, workspace path, agent/provider/mode state, cost spent, candidate lineage, the
strongest verified candidate, verified facts/decisions, and the classified failure reason — and
persists it durably (`RunStore.saveRecoveryCapsule`) before moving the run to `PAUSED`. A capsule
never carries hidden chain-of-thought, only already-structured evidence the system already tracked.
`PAUSED` carries strictly more information than a bare `FAILED` and is used whenever a capsule was
successfully captured; `FAILED` is reserved for the rare case where capsule-building itself fails.

Candidate lineage (`candidateLineage`, `strongestCandidate`) is reconstructed read-only from
already-persisted artifacts and verifications — nothing is ever deleted, so a failed later repair
can never cause an earlier better-verified candidate's *identity and verification result* to be
forgotten. This is a metadata-level guarantee, not a content one: the full diff for a candidate is
only durably stored as a preview truncated to `maxDiffPreviewChars` (12,000 characters by default),
and the worktree's on-disk files reflect only the latest attempt. If a stronger earlier candidate's
diff exceeded that preview and a later, worse attempt has since overwritten the working tree,
`strongestCandidate` still correctly identifies *which* candidate was strongest, but reapplying its
full content is not guaranteed — physical workspace rollback is not implemented.

`RunService.resume()` restarts a `PAUSED` run from its capsule in the preserved worktree (default
retention keeps any non-`VERIFIED` sandbox). Before trusting prior evidence it re-resolves the
capsule's requested revision in the *source* repository and compares it against what the capsule
recorded when it was captured — the frozen worktree cannot itself drift, so the conflict to detect
is the source repository moving on while the run was paused. A mismatch refuses to resume
(`REVISION_CONFLICT`) rather than silently continuing on stale ground.

`RunService.emergencyStop()` cancels every active run — preserving worktrees, evidence, and
candidate lineage exactly as a normal cancellation does — and blocks new run creation until
`resumeNewRuns()` is called. It is a pause, never a wipe.

Explicitly not implemented, stated rather than overclaimed: automatic reload/resume of `PAUSED`
runs after a server process restart (capsules persist across a restart when using the PostgreSQL
store; nothing yet re-triggers resume automatically), and provider/model failover beyond a new
session on the same configured adapter (only one native adapter is wired today).

## Budget authority

`src/domain/budget.ts` is pure domain logic. A task may carry an optional `budget: { mode, limitUsd }`;
absent means fully permissive — nothing to enforce, and every authorization check trivially passes.
`computeAllocation` splits a configured limit into `execution`/`verification`/`recovery` reserves
(default 60/25/15%) so a runaway execution can never consume the money reserved for mandatory
verification or bounded recovery; `authorizeSpend` checks one category's remaining reserve against
its recorded spend (mapped from the existing `CostBreakdown` fields — no new cost tracking was
needed). `ADVISORY` mode never blocks, only reports an overrun; `HARD` mode blocks once a category's
reserve is exhausted. An unconfigured budget or an unauthorized-but-advisory spend is reported as
`null`/`false`, never as `$0` or a silent pass.

`RunService` enforces three gates: before the very first agent session (refuses to start at all —
the M4C "do not execute" strategy — if even the execution reserve cannot fund it, going straight to
a `BudgetExhaustedError`-classified capsule and `PAUSED`), before each bounded repair attempt
(stops repairing — never upgrades the last verification result, so budget reduces scope without
ever silently reducing trust), and before each bounded recovery retry (skips the retry rather than
spending on it). `estimateFromHistory` produces a bounded cost range anchored to prior
cost-per-verified-success telemetry, with `MEDIUM` confidence — genuinely `null` (not a guess) when
no history exists yet. `BudgetAllocated` and `CostEstimated` events are emitted at run creation so
this is inspectable without a dedicated API surface.

Not yet implemented: literal request-level interception for CLI-spawned native agents (their own
provider calls happen inside the child process, outside MAF's process boundary — orchestration-level
gating, described above, is what is actually enforceable for this execution model); project-level
(cross-run, cumulative) budgets — today's budget is per-run only, matching the milestone's stated
minimum.

Cost accounting itself still ultimately depends on `costUsd` the agent process self-reports in its
`usage` events — the same trust boundary M3 already applies to agent-reported error text applies
here too, and enforcement (this milestone) is what actually gives that number teeth. A reported
value is sanitized before being trusted: negative, non-finite, or implausibly large (over
`maxPlausibleSingleEventCostUsd`, currently $1,000) single-event costs are rejected rather than
applied (visible via an `ImplausibleCostIgnored` event), which closes the two concrete abuse
shapes a bad value can cause — driving spend negative, or forcing an immediate self-inflicted
pause. It does **not** close, and cannot without an independently metered provider gateway, an
agent that simply always under-reports (e.g. always claims near-zero) to keep a HARD budget from
ever triggering. A poisoned cost figure also feeds `costPerVerifiedSuccess()` and therefore
`estimateFromHistory`'s range for future runs.

## Provider circuit breaker

`src/domain/circuit-breaker.ts`'s `ProviderCircuitBreaker` is deterministic threshold-and-cooldown
arithmetic — no model is ever consulted to judge provider health. States are `HEALTHY`, `DEGRADED`
(past a failure threshold but still attempting), `OPEN_CIRCUIT` (fast-fails every attempt),
`HALF_OPEN` (exactly one bounded probe attempt allowed once the cooldown elapses). `RunService`
checks `canAttempt()` before every agent-session attempt (initial or retry) and refuses immediately
— without ever calling the adapter — when the circuit is open, so an obviously failing provider is
not retried into the ground. Only provider/network-shaped failure classifications
(`PROVIDER_TRANSIENT`, `PROVIDER_DEGRADED`, `RATE_LIMIT`, `NETWORK_FAILURE`) count against a
provider's health — agent-code-quality or verification failures are a different concern with a
different owner and never affect the breaker. One breaker instance is shared across all runs in a
process, so a provider that just failed for a previous run starts the next run already `DEGRADED`.
A HALF_OPEN probe's outcome always releases its slot one way or the other — via `recordOutcome()`
when it's provider-health-relevant, or `releaseProbe()` when it isn't — so an ordinary agent
failure landing mid-probe can never permanently wedge the circuit open.

Honest applicability: because M3's `AgentReportedFailure` classifies every agent-reported error as
`AGENT_FAILURE` regardless of its text (agent output is never trusted to self-classify), a real
provider outage that a CLI-spawned native agent encounters *inside its own process* surfaces to
MAF as an ordinary agent error, not a provider-classified one — the breaker never sees it. In the
one-adapter-today reality, the breaker is genuinely exercised only by failures the harness/adapter
layer itself raises (e.g. `agent.start()` throwing before any agent process even exists to report
from). It is real, tested, and will matter as soon as a harness-mediated provider path (e.g. a
`ModelGateway`-backed adapter) exists; it does not yet protect against a real outage a CLI agent
silently absorbs and reports as its own failure.

## Task risk profiler and assurance planner

`src/domain/risk.ts` derives a `RiskVector` — ten independent dimensions
(`ReasoningDifficulty`, `CodeCoupling`, `BlastRadius`, `ArchitectureSensitivity`, `DebtRisk`,
`SecuritySensitivity`, `PerformanceSensitivity`, `OperationalSensitivity`, `NetworkBoundaryChanges`,
`DataConsistencyRisk`), never a collapsed scalar score. Each dimension carries a `level`
(`LOW`/`MEDIUM`/`HIGH`) and a `provenance`: `DETERMINISTIC` when derived from real repository
evidence (distinct modules/packages touched via M2's ownership maps, resolved cross-module
`IMPORTS` edges via M2's relations graph, a path-pattern match), `HEURISTIC` when only a weaker
path-pattern proxy is available and nothing matched (so the honest default is "probably not", not
a guessed level), and `INSUFFICIENT_EVIDENCE` for the two dimensions (`ReasoningDifficulty`,
`DebtRisk`) that have no deterministic source yet at all — reported as such rather than guessed.
`CodeCoupling`/`BlastRadius`/`ArchitectureSensitivity` specifically degrade their own provenance
(`coverageProvenance` in risk.ts) based on how many touched files actually have module/package
ownership entries: full coverage stays `DETERMINISTIC`, partial coverage degrades to `HEURISTIC`,
and zero coverage (e.g. a migration- or infra-only diff, since M2's ownership maps only cover
parsed source files) becomes `INSUFFICIENT_EVIDENCE` — a confident "LOW" would otherwise
misrepresent having no visibility as having checked and found nothing. No model is ever called to
assess risk.

`src/domain/assurance.ts`'s `buildAssurancePlan` compiles a `RiskVector` plus the task's
`qualityPreference` (`FAST`/`BALANCED`/`HIGH`/`CRITICAL`, defaulting to `BALANCED`) into an
`AssurancePlan`: a deterministic rule table (not a model call) deciding which of eight checks
(`CORRECTNESS`, `INTEGRATION`, `ARCHITECTURE`, `SECURITY`, `PERFORMANCE`, `CONCURRENCY`,
`RESILIENCE`, `INDEPENDENT_REVIEW`) are required, with a reason recorded for every check —
required or not, never silent. `CORRECTNESS` is always required (the existing trusted-verifier
baseline every candidate already goes through); higher risk or a higher quality preference expands
the required set (`RESILIENCE` is required by either `NetworkBoundaryChanges` or
`OperationalSensitivity` reaching `MEDIUM`, not network-boundary evidence alone); `INDEPENDENT_REVIEW`
only becomes required when `SecuritySensitivity` is `HIGH` *and* the preference is `CRITICAL` — the
M5A rule that a high-risk author must not be the sole judge of its own high-risk work. `HIGH` and
`CRITICAL` preferences are deliberately not treated identically everywhere: `HIGH` alone expands
only `INTEGRATION`, while `SECURITY`/`RESILIENCE` expand only at `CRITICAL` — forcing every
`HIGH`-preference task through a security check regardless of actual risk would defeat "a small,
low-risk change gets a small plan."

`RunService` computes and emits both twice per run, as `RiskProfiled`/`AssurancePlanned` events so
the plan is inspectable evidence, never a hidden internal value: once right after `ContextBuilt`,
from the context builder's selected `initialFiles` (a pre-execution estimate — the only thing
available before any diff exists), and again from the actual diff's `changedFiles` after
`captureCandidate` resolves one (ground truth, refining the estimate with what was actually
touched rather than what was expected to be).

Not yet implemented: wiring the plan's required checks to actual verifiers. M5 only decides what
SHOULD be checked and why; `SECURITY`, `PERFORMANCE`, `ARCHITECTURE`, `CONCURRENCY`, `RESILIENCE`,
and `INDEPENDENT_REVIEW` are not yet backed by real checkers — that is M6-M10's job. A plan
requiring `SECURITY` today does not cause a security scan to run; it only records, with evidence,
that one should. `ReasoningDifficulty` and `DebtRisk` remain `INSUFFICIENT_EVIDENCE` for every run
until a real source exists (`DebtRisk` is the stated target of the M7A roadmap milestone; nothing
is planned yet for `ReasoningDifficulty`).

## Durable state

PostgreSQL stores tasks, runs, events, artifacts, verifications, mode transitions, project knowledge,
credential references, telemetry, runtime-signal snapshots, user/session records, and mission graph
state. Tests use in-memory ports. Numbered migrations live under `migrations/` and run in order.

## Mission tree and project graph

`MissionTree` represents work flow, while `RepositoryIndex` represents code dependency flow.
`VerificationState` is the trust flow. `split`, `merge`, `promote`, and `collapse` are domain
operations. Dependency gates require `VERIFIED` state, regardless of an agent claiming completion.

## Replaceable upstream boundaries

Bifrost, Nango, Agent Vault, Langfuse, codebase-memory-mcp, and future Unkey deployment stay behind
ports or HTTP/protocol adapters. Controllers do not import vendor-specific modules. Exact audited
versions, licenses, and update procedures are in [docs/UPSTREAMS.md](docs/UPSTREAMS.md).
