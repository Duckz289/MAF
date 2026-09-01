# Native-vs-MAF Experiment Protocol v2

Status: `PRE_REGISTERED_NOT_FROZEN`. Manifest: `evaluation/experiments/native-vs-maf-v2.json`.

## 0. Relationship to Protocol v1

[EXPERIMENT_PROTOCOL.md](EXPERIMENT_PROTOCOL.md) (tag `maf-experiment-protocol-v1`, commit
`b183b20a08b1d4f6902bffea49fe139f80cad4e9`) remains unchanged and historically accurate. It
pre-registered the experiment design — arms, controlled variables, metrics, N=3, timeout, budget,
randomization, invalid-run/rerun/stopping/contamination rules, and the provenance schema — and
proved the plumbing around that design with a `BenchmarkRunner.compare` dry run against **mock**
executors (`evaluation/experiments/run-dry-run.ts`). It is preserved as historical evidence of the
first experiment-plumbing design; nothing in it is edited by this document.

**Why v2 exists.** A real-provider preflight against v1 found the mock plumbing could not actually
execute the experiment it described:

- `BenchmarkRunner` had no real `BenchmarkExecutor` for either arm.
- The dry run's own executors always applied a scripted fix directly and returned canned metrics —
  no participant model was ever invoked.
- `src/infrastructure/claude-code-adapter.ts` (`ClaudeCodeAdapter`) already existed and could spawn
  the real Claude Code CLI, but was wired only into the general MAF runtime (`RunService`), not into
  any benchmark executor.
- No real Native execution path and no real MAF execution path existed.
- Real usage/cost had no way to enter experiment provenance.
- The frozen 1,800,000ms timeout and $8.00 HARD budget had never been exercised against a real
  participant.

Protocol v1's experimental design is not being redesigned. **The only material change in v2 is
real-provider execution plumbing and the provenance/cost capture required to actually run the
already-defined experiment.** Every experimental parameter — model, effort, N=3, 29 tasks, 174 total
scoring runs, timeout, budget, primary/secondary/diagnostic metrics, randomization ordering, stopping
rule, invalid-run policy, statistical plan — is identical between v1 and v2, and
`evaluation/experiments/validate-manifest-v2.mjs` checks that identity mechanically rather than by
inspection.

## 1. Target architecture

```
ExperimentRunController (evaluation/experiments/real/lib/experiment-run-controller.ts)
        |
        +--> NativeExperimentExecutor (evaluation/experiments/real/lib/native-executor.ts)
        |       |
        |       +--> ClaudeCodeAdapter (src/infrastructure/claude-code-adapter.ts)
        |
        +--> MafExperimentExecutor (evaluation/experiments/real/lib/maf-executor.ts)
                |
                +--> AdaptiveModeController (src/domain/mode-controller.ts)
                +--> EvidenceRuntimeSignalCollector (src/application/runtime-signal-collector.ts)
                +--> LocalRepositoryIndex (src/infrastructure/project-brain.ts)
                +--> ClaudeCodeAdapter (src/infrastructure/claude-code-adapter.ts)

Both then feed:

ExperimentWorkspaceController-owned candidate workspace (evaluation/experiments/real/lib/workspace-controller.ts)
        v
BenchmarkRunner.compare (src/benchmark/runner.ts, unmodified)
        v
CuratorIndependentVerifier (src/evaluation/curator-verifier.ts, unmodified)
        v
benchmark-bridge / evaluateBenchmarkSamples (src/evaluation/benchmark-bridge.ts, unmodified)
        v
NormalizedEvaluationRun + ExecutorSideChannel
        v
ExperimentProvenanceRecord (evaluation/experiments/real/lib/provenance.ts)
```

Nothing above duplicates the existing benchmark/evaluation system. `BenchmarkRunner`,
`CuratorIndependentVerifier`, `benchmark-bridge`, `src/evaluation/types.ts`, `AdaptiveModeController`,
`EvidenceRuntimeSignalCollector`, `LocalRepositoryIndex`, and `ClaudeCodeAdapter` are all reused
exactly as they already existed (with three small, additive, backward-compatible extensions to
`ClaudeCodeAdapter`, listed in section 4). The new code is the executor layer that drives those
existing pieces with a real participant instead of a mock one, plus a thin provenance-merge layer.

## 2. Real Native executor

`NativeExperimentExecutor` (`evaluation/experiments/real/lib/native-executor.ts`) implements
`BenchmarkExecutor` with `strategy: "NATIVE"`. It:

- fabricates the minimal domain `Run`/`Task` objects `ClaudeCodeAdapter.start()` requires, with
  `effectiveMode: "SOLO_NATIVE"` (maximum native freedom, no MAF policy attached);
- drives one `ClaudeCodeAdapter` session with `promptPreamble: ""`, so the participant receives no
  MAF framing text at all — only the task prompt, exactly as `AgentStartInput.initialContext` is
  otherwise composed for every MAF caller;
- never reads or forwards anything from `evaluation/curator/**` (hidden grader source), a reference
  candidate, hidden assertions, or the private adversarial corpus;
- lets independent verification happen entirely outside itself, in the controller
  (`CuratorIndependentVerifier`, invoked by `BenchmarkRunner.compare`), after execution.

## 3. Real MAF executor

`MafExperimentExecutor` (`evaluation/experiments/real/lib/maf-executor.ts`) implements
`BenchmarkExecutor` with `strategy: "MAF_ADAPTIVE"`, using the actual `AdaptiveModeController`
(`src/domain/mode-controller.ts`, default policy, unmodified) and the frozen Protocol v1 treatment
policy. It is not a simplified stand-in: the same controller class the general MAF runtime uses
decides every mode transition, from the same runtime signals.

Preserved/logged per run: selected mode (initial + every transition), interventions, retries,
escalations, participant/model calls (via `signalSnapshots`), terminal status, and
provider/infrastructure failures. See `MafInterventionRecord` in
`evaluation/experiments/real/lib/provenance.ts`.

### MAF context scoping (a disclosed simplification)

The general MAF runtime (`RunService`) builds initial context through the full `ContextBuilderPort` /
`ProjectBrain` knowledge-base stack. Standing that stack up for the experiment (Postgres-or-in-memory
`ProjectBrain`, `ContextNavigationService`, capability registries, etc.) would mean building a second,
parallel MAF runtime rather than the thin executor this mission asks for. `MafExperimentExecutor`
instead uses `LocalRepositoryIndex` (unmodified) to list the workspace's tracked files and hands that
listing to the participant as `initialContext` — real, deterministic, and exactly the context strategy
named in the treatment policy, just without the additional knowledge-base layer. This is disclosed
here rather than silently narrowed.

### Escalation enforcement limitation (real, not silently patched)

The Claude Code CLI runs one non-interactive `claude -p` invocation per session.
`ClaudeCodeAdapter.capabilities()` reports `livePolicyUpdate: false` and `safeSessionRestart: false`,
and `send()` refuses a second prompt on an existing session. This means:

- the controller **can** observe runtime signals as they stream in and **decide** mode transitions
  with the real `AdaptiveModeController`, in real time, exactly as it would in the general runtime;
- the controller **cannot** enforce a decided transition on a CLI invocation already in flight — there
  is no live-update or safe-restart channel for it to use today.

Every recorded transition therefore carries `enforcementMethod: "DEFERRED_BOUNDARY"` (the closest fit
in `src/domain/types.ts` `ModeEnforcementMethod`) with an explicit `enforcementNote` stating that no
further execution boundary arrived before the run ended for the deferred enforcement to apply at. The
decision, its reason, and its evidence-bound `signalSnapshotId` are still fully recorded — nothing is
hidden — but a report must not read a MAF run's `finalMode` as "the mode the participant executed
under," only as "the mode the policy would have moved to at the next boundary."

This is real-provider preflight evidence, not a hypothetical: it is exactly the kind of gap this
mission's background section says the preflight discovered, applied honestly to the one piece
(mid-session mode enforcement) that no existing adapter capability can close without further work on
`ClaudeCodeAdapter` itself — deliberately out of scope for this mission, which builds and tests
execution plumbing, not a new adapter capability.

### Recovery scope (repaired — see section 15)

Recovery is scoped to exactly what the frozen treatment policy describes: provider-transient handling
only. Classification is performed by `evaluation/experiments/real/lib/session-outcome.ts`
`classifyAttemptOutcome` from **structured evidence** (exit code, terminating signal, the CLI's own
result subtype / `is_error`, stderr shape) — never from a synthesized message string. `PROVIDER_FAILURE`
is the **only** auto-retryable class. A participant task failure, an auth/configuration failure, a bare
nonzero exit, a signal termination, a timeout and a cancellation are all non-retryable.

Retries are additionally gated by the run ledger (section 8): even a genuinely retryable provider
failure will not spawn a second process if the invocation ceiling, the run deadline or the run budget
is exhausted, or if a prior attempt's cost was unmeasured. `retryCount` counts attempts that were
actually **authorized and started**, never attempts that were merely wanted.

## 4. Claude Code adapter reuse

`src/infrastructure/claude-code-adapter.ts` is reused, not duplicated. Small, additive,
backward-compatible fields were added after auditing its interface, each because the existing code
already receives the underlying data and was simply not surfacing it:

1. **`ClaudeCodeConfig.promptPreamble`** (default: the historical MAF framing sentence, unchanged for
   every existing caller). Lets `NativeExperimentExecutor` pass `""` so the Native arm never receives
   MAF framing text, which the previous hardcoded preamble made impossible for any caller.
2. **Resolved model capture.** The CLI echoes the underlying Anthropic Messages API response per
   assistant turn, which carries the concrete resolved model id on `message.model`. `consume()` now
   captures it (when present) and attaches it to the final `usage` event as `resolvedModel`. Never
   invented: absent unless the CLI actually reported one.
3. **Result `subtype` capture.** The CLI's `result` event carries a structured terminal classification
   (e.g. `"success"`, `"error_during_execution"`). `consume()` now forwards it on the `complete`
   event's `data.subtype`. This is still self-reported, untrusted evidence — the CLI's own claim about
   its own turn — but it is a structured field instead of a free-text heuristic, so both executors use
   it (not text pattern-matching) as their self-reported completion signal.
4. **Testability-only script-command support.** `send()` now detects a `.mjs`/`.cjs`/`.js` `command`
   and runs it through the current Node binary instead of trying to execute it directly (Windows
   cannot execute a script file via `spawn(..., {shell: false})`, which this adapter deliberately never
   enables). The real `"claude"` command is unaffected; this exists solely so
   `tests/claude-code-adapter.test.ts` can drive the real adapter against a deterministic fake CLI
   script without spawning any shell.
5. **`ClaudeCodeConfig.effort`** (repair — see section 15, Finding 4). Typed as
   `ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max"`, matching the installed CLI's
   documented `--effort` values, and emitted as a real `--effort <level>` argument. Omitted entirely
   when unset, so every existing caller is unaffected.
6. **`is_error` capture.** The CLI's terminal `result` line carries an `is_error` flag; `consume()`
   now forwards it on the `complete` event. Without it an ERROR result and a SUCCESS result were
   indistinguishable to callers, which is half of the terminal-state collapse in Finding 2.
7. **Exit code / terminating signal separated.** `child.on("close", (code, signal))` now reports both,
   and never coerces `code === null` (signal termination) into `exitCode: 1`. Conflating them made a
   killed process indistinguishable from a genuine `exit(1)` in every downstream record.
8. **`spawnRecord(session)`.** Returns the executable and exact argv actually spawned, so a run can
   prove which binary and which arguments really ran.

No Anthropic SDK was introduced. All provider invocation still goes through the one place that already
spawns the CLI and parses its stream-json output. The adapter's curated environment allowlist is
**unchanged**: no `ANTHROPIC_*` routing or credential is ever forwarded to a participant, which is
asserted by `tests/claude-code-adapter-env.test.ts` against a probe process rather than assumed.

## 5. Model resolution and effort enforcement

Requested: `claude-sonnet-5`, effort `high` (per manifest `modelConfiguration`). **Both are now
actually sent**: `--model claude-sonnet-5 --effort high`, proven by
`tests/claude-code-adapter.test.ts` two independent ways (the adapter's own `spawnRecord`, and an
argv log written by the fake CLI from what it actually received). Provenance carries
`effortArgumentEmitted` so a report states whether the controlled variable was enforced rather than
merely declared.

Every provenance record carries `requestedModel`, `resolvedModel` (nullable), the verbatim
`rawReportedModel`, a `modelProvenanceNote`, and `resolvedModelStatus`
(`evaluation/experiments/real/lib/diagnostics.ts`):

- `RESOLVED` — the provider reported a concrete model identifier distinct from the alias.
- `ALIAS_ONLY` — the provider echoed only the requested alias; no underlying version is invented.
- `PLACEHOLDER_OR_SYNTHETIC` — the provider reported a stand-in (`<synthetic>`, `<unknown>`,
  `mock-*`, `placeholder`, …) rather than a real identity. Detected by general shape, not by a
  denylist of the one literal observed. `resolvedModel` is `null`; the raw string is preserved.
- `NOT_REPORTED` — no model identity was reported at all.

`modelProvenanceAcceptableForPreflight()` accepts only `RESOLVED` or `ALIAS_ONLY`. A placeholder
identity therefore **blocks** a successful real-provider preflight instead of being recorded as
resolved provenance, which is exactly what the first billed preflight did wrong (section 15).

## 6. Workspace ownership

`ExperimentWorkspaceController` (`evaluation/experiments/real/lib/workspace-controller.ts`) creates
and owns every candidate workspace. A participant's own output cannot redirect the workspace, repo
path, grader path, or candidate path: those paths are fixed by the controller and handed to the
participant, never derived from anything the participant returns. Both arms' workspaces are
byte-identical copies of the pristine fixture (git-initialized identically, purely so
`LocalRepositoryIndex`'s `git ls-files` call works for the MAF arm — Native's own context never comes
from that git history). Scoring runs will start from the exact frozen task seeds under
`evaluation/fixtures/phase-b` / `evaluation/fixtures/phase-c`, unchanged from v1.

## 7. Terminal-state precedence and timeout wiring

`evaluation/experiments/real/lib/session-outcome.ts` owns one explicit precedence table, evaluated
strictly top to bottom; the first matching rule wins and later evidence can only be **recorded**,
never silently override it:

| # | Condition | Outcome |
|---|---|---|
| 1 | controller cancelled | `CANCELLED` |
| 2 | controller deadline fired | `TIMEOUT` |
| 3 | adapter spawn/transport error, no structured result | `INFRASTRUCTURE_FAILURE` (or auth/provider if stderr proves it) |
| 4a | structured result, `subtype: success`, not `is_error` | `COMPLETED` — **a later nonzero exit does not erase it**; the disagreement is recorded as `exitCodeDiscrepancy` |
| 4b | structured result, known participant-limit subtype (`error_max_turns`, `error_max_tokens`) | `PARTICIPANT_TASK_FAILURE` — a **valid** run with a non-DVS outcome (protocol 17.1), never rerun |
| 4c | any other error result / `is_error` | auth or provider if stderr proves it, else `CLI_PROCESS_FAILURE` (**fail closed**, not retryable) |
| 5 | no structured result | auth or provider if stderr proves it, else `CLI_PROCESS_FAILURE` — a bare nonzero exit or signal proves no cause and is **never** auto-retryable |

The frozen 1,800,000ms timeout is a **run-level** deadline owned by
`evaluation/experiments/real/lib/run-ledger.ts`, not a per-attempt one. The deadline is fixed when the
run starts; each attempt receives only `remainingRunTimeMs()`. A retry therefore never restarts the
30-minute timer, and an attempt is refused outright (`RUN_DEADLINE_EXHAUSTED`) when too little time
remains to be useful. On expiry `adapter.cancel(session)` sends `SIGTERM`, which reports
`(code=null, signal=SIGTERM)` — recorded as a signal, never as `exit(1)`.

## 8. Budget wiring: run-level, and its honest limits

The frozen ceiling is **$8.00 per RUN, not per attempt**. Before this repair each adapter invocation
received the full `--max-budget-usd 8`, so one MAF run that retried once could have spent up to $16
while every report still claimed the per-run ceiling was honored.

`RunExecutionLedger` (`evaluation/experiments/real/lib/run-ledger.ts`) now owns the run budget:

- `beginAttempt()` must be called, and must return `allowed: true`, **before any process is created**.
- Each attempt's `--max-budget-usd` is set to `remainingRunBudgetUsd()`, never the full ceiling.
- A retry is refused when the remainder falls below a practical minimum (`RUN_BUDGET_EXHAUSTED`).
- **Fail closed on unknown cost.** If any completed attempt never reported a cost, the remaining
  budget is genuinely unknowable, so `remainingRunBudgetUsd()` returns `null` and any further billed
  attempt is refused (`REMAINING_BUDGET_UNKNOWN`) rather than run against an unmeasured ceiling.
- Refused attempts are recorded in provenance, so a blocked retry is visible rather than absent.

Worked examples, all covered by `tests/experiment-run-ledger.test.ts` and
`tests/experiment-maf-executor.test.ts`: attempt 1 costs $3 → retry ceiling $5; attempt 1 costs $7.50
→ retry ceiling $0.50; attempt 1 costs $7.99 → retry refused; attempt 1 cost UNKNOWN → retry refused.

**What is still not claimed:** the controller does not itself meter spend *during* an attempt and
cannot verify the CLI's internal enforcement granularity — a single non-interactive `claude -p`
invocation reports nothing until it exits. `controllerEnforcesRealTimeCutoff` remains hard-coded
`false`. What the controller *does* now guarantee is that the **sum of attempts** cannot knowingly
exceed the frozen per-run ceiling.

## 9. Cost capture

Never `UNKNOWN -> 0`. See `ExecutorSideChannel.cost` / `ExperimentProvenanceRecord.cost`
(`evaluation/experiments/real/lib/provenance.ts`):

- **Native**: `participantCostUsd`, `participantInputTokens`, `participantOutputTokens`,
  `participantCacheTokens`, `verificationCostUsd` (always `0` — the controller-side grader/regression
  check runs locally and calls no model), `totalCostUsd`, `costStatus`.
- **MAF**: the same fields, plus `orchestrationCostUsd` (always `0` — signal collection and mode
  decisions run locally and call no model of their own; genuinely zero, not unknown).

When a run never produced a usage event (it timed out or crashed before the CLI emitted its final
result line), `participantCostUsd`/`totalCostUsd` are `null`, `costStatus` is `"UNKNOWN"`, and a `note`
explains that the `0` token counts reflect "never observed," not "confirmed zero" — the frozen
`BenchmarkExecution` contract requires integer token fields, so `0` is what is stored there, but the
richer provenance record's `costStatus`/`note` is what actually says whether that `0` means "measured"
or "unknown."

### Multi-attempt aggregation (repair)

Cost is summed over **every attempt**, not taken from the final one. A failed attempt's spend is real
money and never disappears because a retry succeeded: a $2 failed attempt followed by a $1 successful
retry reports `participantCostUsd: 3` (`tests/experiment-maf-executor.test.ts`). `costStatus` is
`KNOWN` only when every attempt reported; `PARTIAL` when some did (with a note stating the figure is a
**lower bound**); `UNKNOWN` when none did.

`orchestrationCostUsd` is `0` because MAF's signal collection and mode decisions run locally and call
no model of their own. That is now **provable rather than asserted**: every entry in the `attempts`
array carries `purpose`, and a test confirms all of them are `PARTICIPANT` — so a zero here means "no
billed orchestration call occurred", not "we assumed local computation is free".

## 10. Provenance schema

`ExperimentProvenanceRecord` (`evaluation/experiments/real/lib/provenance.ts`) extends
`EXPERIMENT_PROTOCOL.md` section 20 with the fields that schema left implicit or that only a real
executor can supply: `resolvedModel`/`resolvedModelStatus`/`rawReportedModel`/`modelProvenanceNote`,
`effort`/`effortArgumentEmitted`, `timeoutMs`/`timedOut`, `budget`/`BudgetEnforcementRecord`,
per-category `cost`, `candidateWorkspace`, and (MAF only) `maf: MafInterventionRecord`. Every other
field is copied, not re-derived, from the existing audited pipeline: `NormalizedEvaluationRun`
(`hiddenGrader`, `regression`, `regressionEvidence`, `dvs`, `runValidity`, `effectiveRunValidity`,
`candidateIntegrity`, `usage`, `executorSelfReport`, `infrastructureStatus`).

### Diagnostics that survive a failure (repair — Finding 3)

The first billed preflight recorded nothing beyond `"agent process exited with code 1"` for either
arm, making its own forensic diagnosis impossible. Every record now additionally carries:

- `firstFailure` — a structured statement of **what first failed**, never a bare exit-code restatement.
- `failureClassification` — the `AttemptFailureClass` from the precedence table in section 7.
- `attempts[]` — one `AttemptRecord` per provider invocation, **including refused ones**, each with
  attempt number, `purpose`, `started`, refusal reason/detail, requested + reported model and its
  resolution status, effort, timestamps and duration, the `attemptTimeoutMs`/`attemptBudgetUsd` it ran
  under, usage, cost and cost status, `resultSubtype`, `resultIsError`, `exitCode`,
  `terminationSignal`, `classification`, `exitCodeDiscrepancy`, bounded `stderr`, and the `spawn`
  record (executable + argv).
- `ceilings` — `runTimeoutMs`, `runDeadline`, `remainingRunTimeMsAtEnd`, `runBudgetUsd`,
  `remainingRunBudgetUsdAtEnd` (nullable), and `providerInvocationsAllowed` / `Started` / `Refused`.

**stderr is bounded and redacted** (`evaluation/experiments/real/lib/diagnostics.ts`): a `summary`
(first meaningful line, ≤400 chars), a `tail` (≤4000 chars), `totalChars` and a `truncated` flag so a
bounded tail is never mistaken for the whole stream. Redaction runs over the **full** text before
truncation, so a secret straddling the truncation boundary cannot survive by being half-copied. No
credential, token, authorization header or sensitive environment value is ever persisted.

## 11. NON_SCORING exclusion

`assertNonScoringExcluded` (`evaluation/experiments/real/lib/provenance.ts`) proves structurally, not
just by comment, that a `NON_SCORING` record's `taskId` never collides with the frozen 29-task suite;
`tests/experiment-provenance.test.ts` exercises both the non-colliding and colliding cases. The
preflight fixture lives entirely under `evaluation/experiments/real/fixtures/preflight-phase`, outside
`evaluation/fixtures/phase-b` and `evaluation/fixtures/phase-c`.

## 12. Real-provider preflight command

`npm run experiment:real-preflight` (`evaluation/experiments/run-real-preflight.ts`), optionally with
`--claude-path <path>` to pin an exact executable.

Without `--confirm-billed-run` it runs eight gates and stops before any provider invocation:

1. v1/v2 manifest equivalence (delegated to `validate-manifest-v2.mjs`) and frozen tag resolution.
2. **Executable resolution** — resolves ONE executable and captures its `--version` (no model call).
3. **Auth gate** — `claude auth status` on that **same** executable (no model call). Reports
   `loggedIn`, `authMethod`, `apiProvider`; never any credential value.
4. **Environment routing gate** — records whether the controller's own environment carries
   `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / `ANTHROPIC_AUTH_TOKEN`, and that none of it is forwarded
   (`externalModelOverrideForwarded: false`, etc.). Presence only, never values.
5. Controller-owned synthetic workspaces.
6. Real executors, constructed with `maxProviderInvocations: 1` and `maxRecoveryAttempts: 0`.
7. The independent verifier.
8. The planned executions, then cleanup.

It prints `READY_FOR_BILLED_PREFLIGHT` only when every gate passes; if the executable cannot be
resolved or is not authenticated it prints the unmet gates and
`PREFLIGHT_ENVIRONMENT_REPAIR_REQUIRED` instead. Steps 2–4 are the direct answer to the first billed
preflight, which version-checked one binary and then spawned a bare `claude` resolved through `PATH`,
with no auth check at all.

With `--confirm-billed-run` it **re-checks the same gates and refuses to spend anything if they are
unmet**, then executes exactly one `NON_SCORING` Native run and one `NON_SCORING` MAF run against
`evaluation/experiments/real/fixtures/preflight-phase/preflight-task` only — never a frozen Phase B/C
task. The scope is enforced structurally: `maxProviderInvocations: 1` per arm means the ledger refuses
a second spawn **before process creation**, so the 2-invocation authorization cannot be exceeded even
by a genuinely retryable provider failure. The written report exposes
`providerInvocations: { allowedPerArm, attempted, started, refused, byArm }`.

## 13. Testing

No test makes a provider call. Fixtures: `tests/fixtures/fake-agent-adapter.ts` (scripted adapter
double), `tests/fixtures/fake-signal-collector.ts`, `tests/fixtures/fake-claude-cli.mjs` (a real
subprocess emitting representative stream-json), `tests/fixtures/fake-claude-env-probe.mjs`.

| Suite | Covers |
|---|---|
| `experiment-session-outcome.test.ts` | the full precedence table; that a bare nonzero exit is **not** retryable while a provider failure still is; that the old synthesized-string path *would* have retried (regression pinned to a test) |
| `experiment-run-ledger.test.ts` | invocation ceiling; run budget across retries ($3→$5, $7.99→refused); run deadline across retries (20min→10min); unknown-cost fail-closed; multi-attempt aggregation |
| `experiment-native-executor.test.ts` | success, participant limit, bare-exit non-retry, timeout, stderr/exit/subtype persistence, UNKNOWN cost, placeholder model, one-invocation ceiling |
| `experiment-maf-executor.test.ts` | success, escalation, provider retry, non-retryable classes, preflight ceiling blocking a second spawn, cumulative budget/timeout, $2+$1=$3 cost, PARTIAL cost, success-then-nonzero-exit |
| `claude-code-adapter.test.ts` | fake-CLI contract: success, error result, success-then-nonzero-exit, malformed stream, bare nonzero exit, signal vs exit(1), stderr capture, placeholder model, unknown cost, hang+cancel, spawn record, **`--effort high` actually emitted** |
| `claude-code-adapter-env.test.ts` | no `ANTHROPIC_*` routing or credential reaches a participant process (proven against a probe) |
| `experiment-diagnostics.test.ts` | placeholder model detection (general, not one literal); stderr bounding, truncation flag, secret redaction |
| `experiment-trust-boundary.test.ts` | a process anomaly can never mint a DVS; self-report stays untrusted; both grader **and** regression still required |
| `experiment-provenance.test.ts`, `experiment-workspace-controller.test.ts`, `experiment-budget-guard.test.ts` | provenance assembly, NON_SCORING exclusion, workspace ownership/cleanup, budget honesty |

## 14. No protocol v2 freeze tag yet

`maf-experiment-protocol-v2` is not created by this mission. `validate-manifest-v2.mjs` asserts the
tag does not exist. Protocol v2 cannot freeze until a real billed synthetic preflight
(`--confirm-billed-run`) has actually **succeeded** — the first attempt did not (section 15).

## 15. First billed preflight: INVALID_PREFLIGHT_ATTEMPT

The first billed Protocol v2 preflight (2026-09-01T09:40:01Z) executed one Native and one MAF
`NON_SCORING` run and returned `INVALID_BOTH`, both arms `INFRA_FAILURE` with
`providerError: "agent process exited with code 1"`.

**It is not experiment data.** It is not part of the 174 planned scoring runs, contributes to no
metric, and is not rewritten as successful. Its report was archived unmodified outside the repository
before any repair began:

| | |
|---|---|
| Archive | `C:\Users\Admin\Documents\MAF-preflight-forensics\preflight-report-INVALID-ATTEMPT-2026-09-01T09-40-01Z.json` |
| SHA-256 | `eabfa5083d9978994673dea81965517c050dc243bbd46b308a6b720d1279f4fe` |
| Size | 13652 bytes |
| Source HEAD | `1aef2005292b17d0367e47caf1a9055a252c4941` |

Runtime reports are **not tracked in Git** (the in-repo copy was untracked and was removed after
archiving); only the checked-in protocol/manifest/source are versioned.

### Why it was invalid, and what each finding repaired

1. **Authorization overrun.** Two participant executions were authorized; the MAF arm auto-retried the
   nonzero exit (`retryCount: 1`), so the run most likely made **three** Claude invocations. Cause:
   `agent-session-runner.ts` synthesized `"agent process exited with code N"`, and
   `src/domain/recovery.ts` pattern-matched that string into the auto-retryable `AGENT_FAILURE`.
   `recovery.ts` was never the bug — its behavior is correct for the genuine agent messages it was
   built for — the bug was round-tripping a synthesized string through a text matcher. **Repaired** in
   section 3/7 (structured classification) and section 8 (a ceiling enforced before spawn).
2. **Terminal-state collapse.** `hasComplete && !errorMessage ? COMPLETED : INFRA_FAILURE` erased a
   structured success on any later nonzero exit, and could not tell an ERROR result from a SUCCESS one.
   **Repaired** by the precedence table in section 7.
3. **Diagnostics discarded.** stderr, result subtype and exit code were observed by the adapter and
   dropped before provenance. **Repaired** in section 10.
4. **Effort never enforced.** Provenance claimed `effort: "high"` while `--effort` was never emitted,
   so both arms ran at the CLI default. **Repaired** in section 5.
5. **Untrustworthy model provenance.** `resolvedModel: "<synthetic>"` was recorded as `RESOLVED`.
   **Repaired** in section 5; such an identity now blocks a successful preflight.

### MODEL_VERSION_REPRODUCIBILITY_RISK

`claude-sonnet-5` is an alias. Whether an immutable underlying version is observable can only be
established by a real provider call, which this repair mission was not authorized to make. Provenance
now distinguishes `RESOLVED` from `ALIAS_ONLY` and refuses `PLACEHOLDER_OR_SYNTHETIC`, so whichever
holds will be recorded honestly rather than assumed. If the next billed preflight yields `ALIAS_ONLY`,
that is a disclosed reproducibility limitation to weigh before scoring begins — not a blocker this
mission can resolve, and deliberately not papered over by inventing a version.
