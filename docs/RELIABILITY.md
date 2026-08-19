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
trusted repair success, false stabilization, anti-oscillation, worktree cleanup,
fact staleness, verified-only mission gating, API control, signal-explanation endpoints, SSE,
bounded auto-recovery with a fresh session, capsule capture and pause on a non-retryable failure,
resume from a preserved worktree, revision-conflict refusal, and emergency stop.
The production-bundle smoke test repeats both outcomes against in-memory and PostgreSQL adapters.
