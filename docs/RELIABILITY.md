# Reliability boundary

## Execution state

Agent output moves through `PROPOSED`, `VERIFYING`, and either `VERIFIED` or `QUARANTINED`. Failures
and cancellation use `FAILED` and `CANCELLED`. Mission dependencies accept only `VERIFIED` output.

## Worktree lifecycle

```text
BEGIN
create detached worktree
run native agent
capture diff and artifact digest
verify
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

## Tested paths

Automated tests cover VERIFIED, QUARANTINED, CLI native execution, ACP native execution, adaptive
mode changes, worktree cleanup, fact staleness, verified-only mission gating, API control, and SSE.
The production-bundle smoke test repeats both outcomes against in-memory and PostgreSQL adapters.
