# Reliability boundary

## Execution state

Agent output moves through `PROPOSED`, `VERIFYING`, and either `VERIFIED` or `QUARANTINED`. Failures
and cancellation use `FAILED` and `CANCELLED`. Mission dependencies accept only `VERIFIED` output.

## Worktree lifecycle

```text
BEGIN
create detached worktree
run native agent
capture attempt-linked candidate diff and artifact digest
verify (at most twice with one bounded repair)
derive candidate runtime graph
measure baseline/candidate performance when required and configured
emit VERIFIED or QUARANTINED
apply retention
emit SandboxFinalized
```

`SANDBOX_RETENTION` accepts `none`, `failed`, or `all`. The default `failed` preserves the workspace,
diff preview, changed-file list, agent events, and verification output for debugging. Cleanup checks
that the target is an immediate child of the configured sandbox root before removing it.

## Cancellation and time bounds

The API marks a run cancelled, asks the verifier to cancel, and terminates an active agent session.
Command verification defaults to 120 seconds and is capped by API validation at 10 minutes. Gateway
retries are bounded by configuration. No retry loop is unbounded.

## Evidence

Every diff artifact has a SHA-256 digest. Mode changes contain evidence. Repository facts require
evidence and become stale across revisions. Failed runs retain enough evidence to diagnose without
trusting an agent's completion message.

Runtime-signal history is persisted per run, while each snapshot bounds its evidence payload to the
50 most recent records. Scope stabilization requires five consecutive meaningful observations with
stable file/module/dependency scope, bounded edit targets, and no unresolved verifier failure.
Mechanical remaining work additionally requires at least two equivalent edit patterns, bounded
targets, and low uncertainty. Verification failures come from stored verifier results, so a
caller-provided count cannot override them. A three-observation cooldown blocks immediate narrowing
and cumulative-signal escalation, while explicit new evidence can invalidate and leave `STRICT`.

The repair policy defaults to one repair and two total verification attempts. Verifier output and
diff previews sent to repair are each capped at 12,000 characters. Every attempt is stored with a
candidate ID; candidate artifacts record their parent. Exhaustion or a worse verification state
stops the loop and retains `QUARANTINED` evidence. An agent completion message never changes trust.

## Runtime and performance assurance

The source Project Graph and deployment Runtime Graph are separate models. M9 derives only runtime
nodes/edges evidenced by changed paths and added code (browser, application/API, database, cache,
storage, service). A server-side network call remains a service with unknown ownership unless the
diff explicitly identifies an external API. Edge properties such as timeout, retry,
authentication, rate limiting, payload behavior, and consistency stay `null`/unknown unless the
diff supplies evidence.

Performance-sensitive DB/query, pagination/index, network, bundle, serialization, payload, hot-path,
and memory signals refine `PerformanceSensitivity` at the diff-captured stage. When the assurance
plan requires `PERFORMANCE`, `CommandPerformanceVerifier` runs the configured bounded command in a
fresh detached baseline worktree and the candidate worktree, takes bounded samples, and binds the
result to the candidate ID and full diff digest. A dirty/unresolvable baseline, failed/non-numeric
command, identity mismatch, zero baseline, or workspace mutation is `NOT_CHECKED`, never PASS. A
measured regression above `maxRegressionPercent` is `FAIL`; either state blocks the required quality
gate. Performance commands are skipped for plan-exempt ordinary work.

## Resilience assurance

M10 derives which production-like failure scenarios are relevant to a candidate from the diff's
added code content alone — outbound dependency calls imply the network family (high latency,
timeout, connection reset, malformed upstream response, rate limiting), consistency-critical write
paths imply duplicate request, concurrent completion paths imply out-of-order response, and a plan
requiring `CONCURRENCY` forces the interleaving pair. Comments, filenames, and test/fixture/script
paths are not evidence. When the plan requires `RESILIENCE`, `CommandResilienceVerifier` runs the
configured trusted command once per relevant scenario with `MAF_RESILIENCE_SCENARIO` set (optionally
managing a bounded Docker Compose environment, 120s up/down, no Kubernetes), binds the result to the
candidate ID and diff digest, and re-collects the workspace digest afterwards so mutation
invalidates the evidence. Missing specification/verifier, stale binding, an unexecuted relevant
scenario, or a failed scenario yields `NOT_CHECKED`/`FAIL`, never PASS, and gates promotion. A
diff with no relevant scenario passes deterministically without consulting the verifier (an
uninspectable binary patch on an evidence path fails closed to `NOT_CHECKED` instead). Evidence
states this in plain language: local scenario execution is resilience evidence, not production
verification. Candidate-relative Compose configuration and up to 50 explicitly declared ignored
or generated `evidenceInputs` are bounded, path-confined, and content-fingerprinted before and after
execution; mutation or an unverifiable input yields `NOT_CHECKED`. Compose is launched from the
candidate sandbox, never the mutable source repository. Cancellation during verification is honored — a cancelled run stays `CANCELLED` and
never emits `RunCompleted`; in-flight scenario subprocesses are terminated promptly (SIGTERM, then
a forced tree kill after 5s) rather than awaited, and on Windows the scenario command's real exit
code is propagated explicitly (`exit $LASTEXITCODE`) because `powershell -Command` otherwise
collapses every nonzero native exit to 1.

## Recovery

An unhandled execution failure is classified deterministically (`src/domain/recovery.ts`) into one
of twelve categories, defaulting honestly to `UNKNOWN_FAILURE` rather than guessing. Only
provider/network/agent-process failure classes are auto-retried, bounded by `maxRecoveryAttempts`
per run (default 1), always with a brand-new session — never a resume into the session that just
failed. Anything not auto-retryable, or that exhausts its retry budget, gets a durable
`RecoveryCapsule` (candidate lineage, verified facts/decisions, cost spent, mode state, the
classified reason) persisted via `RunStore`, and the run moves to `PAUSED` rather than a bare
`FAILED`. `PAUSED` is used whenever a capsule was successfully captured, since it carries strictly
more actionable information.

`RunService.resume()` restarts a `PAUSED` run in its preserved worktree, but first re-resolves the
capsule's requested revision in the source repository and refuses to resume if it has moved since
the capsule was captured (`REVISION_CONFLICT`) — a paused run is never silently continued on stale
ground. If that resolution is itself inconclusive (a transient git failure at capture or resume
time), resume is refused rather than treated as "no conflict" — unknown stays unknown. Resume also
refuses outright if the preserved workspace no longer exists on disk, which happens whenever
`SANDBOX_RETENTION=none` — that retention setting deletes every sandbox regardless of outcome and
is incompatible with resuming a paused run; use the default (`failed`) or `all` if recovery matters
for a deployment. Neither `resume()` nor new-run creation is permitted while an emergency stop is
active. `RunService.emergencyStop()` cancels every active run while preserving all worktrees,
events, artifacts, and candidate lineage, and blocks new run creation until explicitly resumed; the
flag is re-checked immediately before a run's first agent session starts (no `await` in between),
closing the window where a run created concurrently with the stop could otherwise slip through.

An agent's own reported error message never drives its failure classification beyond
`AGENT_FAILURE` — pattern-matching arbitrary agent-supplied text into a more specific category
(rate limit, credential failure, even the harness's own cancellation wording) would let agent
output silently masquerade as harness-determined ground truth in the durable capsule. Only errors
the harness itself raises (cancellation, sandbox/git failures, scope-indexing failures) are
pattern-matched into the full taxonomy.

Not yet implemented, stated rather than assumed: automatic reload/resume of paused runs after a
server process restart, physical workspace rollback to an earlier candidate's full diff content
(candidate lineage tracks identity and verification result durably, not full diff content beyond a
12,000-character preview), and provider/model failover beyond a new session on the same adapter. A
same-process resume reuses the existing in-memory runtime-signal history; a resume in a fresh
process (after a restart) re-seeds that history from empty, since it is not itself persisted.

## Tested paths

Automated tests cover VERIFIED, QUARANTINED, CLI native execution, ACP native execution, adaptive
mode changes, reversible `STRICT`, stable and invalidated scopes, bounded repair, retry exhaustion,
trusted repair success, false stabilization, anti-oscillation, worktree cleanup, runtime-graph
derivation, real baseline/candidate performance measurement, performance regression/unknown gating,
fault-scenario relevance derivation, executed-scenario candidate binding, failed/unexecuted
scenario gating, deterministic relevance-empty pass, resilience label sanitization, and
cancellation during resilience verification, real-subprocess verifier behavior (scenario env
delivery, exit-code fidelity through the Windows shell, timeout bounding, spec allowlists, and
prompt mid-sweep cancellation kills),
fact staleness, verified-only mission gating, API control, signal-explanation endpoints, SSE,
bounded auto-recovery with a fresh session, capsule capture and pause on a non-retryable failure,
resume from a preserved worktree, revision-conflict refusal, and emergency stop. The health ledger
is covered by domain tests for every metric group, source-only lexical scans, uninspectable-change
UNKNOWN behavior, dependency-upgrade
exclusion, overlap-safe duplication evidence, trend incompleteness/lineage honesty, and the
maintenance-need thresholds, plus an end-to-end test that a completed run appends a real sample and
that trend/maintenance appear only from the second sample on.
Focused persistence coverage exercises ordered/bounded project windows (including limit zero),
duplicate/malformed/cross-project/unbound-candidate rejection in memory, migration-006 schema,
PostgreSQL round-trip identity, verified candidate/artifact/digest/base-revision binding, and rejection of payload
revision drift. The PostgreSQL test uses an isolated temporary schema and runs only when
`DATABASE_URL` is configured; the M11 validation log records the live local-container result.
Only trusted-verifier-passing candidates enter the ledger. Each row binds project, run, candidate,
diff digest, resolved base revision, timestamp, and `VERIFIED_CANDIDATE` basis; this describes a
pre-merge observation and cannot impersonate CI, deployment, or production health. Structure is
frozen before candidate execution and labeled `BASE_REVISION`; change is labeled
`VERIFIED_CANDIDATE_DIFF`. Without proven revision ancestry, structural directions are always
`UNKNOWN`, and incomplete successful-parse/truncation evidence is explicit.

Strategy-learning tests prove no/tiny evidence remains SHADOW, sufficient scoped durable evidence
can progress through CANARY to PROMOTED, security degradation DEMOTEs, unknown costs cannot satisfy
promotion, Project A evidence cannot authorize Project B, and an unapproved challenger cannot
displace native frontier for CRITICAL work. Benchmark coverage proves optional full identities and
scopes emit shadow observations while the legacy comparison remains compatible. Executor JSON is
runtime-validated, missing cost becomes UNKNOWN, and reported identity must match the execution.
In-memory and live PostgreSQL tests prove strategy observations round-trip only when their
verified run/candidate/project/strategy bindings match; RunService integration proves completed
runs and terminal verifier failures produce those observations, so failure rate is not
success-survivor biased. Canonical task/risk/review scope is rebound at persistence, the canary
allocator is monotonic, store-owned, and isolated by exact scope + challenger identity, and its
service consumer selects exactly 2 of 20 eligible slots in the deterministic regression. Store
tests also reject backdated/repriced/repainted lifecycle fields even when the run and candidate IDs
are genuine.
The production-bundle smoke test repeats both outcomes against in-memory and PostgreSQL adapters.
