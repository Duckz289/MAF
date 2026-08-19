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

## Tested paths

Automated tests cover VERIFIED, QUARANTINED, CLI native execution, ACP native execution, adaptive
mode changes, reversible `STRICT`, stable and invalidated scopes, bounded repair, retry exhaustion,
trusted repair success, false stabilization, anti-oscillation, worktree cleanup,
fact staleness, verified-only mission gating, API control, signal-explanation endpoints, and SSE.
The production-bundle smoke test repeats both outcomes against in-memory and PostgreSQL adapters.
