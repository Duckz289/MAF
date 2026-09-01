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

### Recovery scope

Recovery is scoped to exactly what the frozen treatment policy already describes:
`src/domain/recovery.ts` `classifyFailure`/`isAutoRetryable`-driven provider-transient handling only.
On an `INFRA_FAILURE` result, the executor classifies the failure and retries at most once (matching
`RunService`'s own `defaultRecoveryPolicy.maxRecoveryAttempts = 1`) if and only if the classification
is auto-retryable (`PROVIDER_TRANSIENT`, `PROVIDER_DEGRADED`, `RATE_LIMIT`, `NETWORK_FAILURE`,
`AGENT_FAILURE`). A `TIMEOUT` is never retried. Retry count is recorded on both the frozen
`BenchmarkExecution.retryCount` field and the side-channel `maf.retries` field.

## 4. Claude Code adapter reuse

`src/infrastructure/claude-code-adapter.ts` is reused, not duplicated. Three small, additive,
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

No Anthropic SDK was introduced. All provider invocation still goes through the one place that already
spawns the CLI and parses its stream-json output.

## 5. Model resolution

Requested: `claude-sonnet-5`, effort `high` (per manifest `modelConfiguration`). Every provenance
record carries both `requestedModel` and `resolvedModel` (nullable) plus `resolvedModelStatus`:

- `RESOLVED` — the CLI reported a concrete model id on an assistant message (item 2 above).
- `ALIAS_ONLY` — no such id was ever observed; only the requested alias is known.

No immutable dated snapshot id is ever invented when the CLI does not report one.

## 6. Workspace ownership

`ExperimentWorkspaceController` (`evaluation/experiments/real/lib/workspace-controller.ts`) creates
and owns every candidate workspace. A participant's own output cannot redirect the workspace, repo
path, grader path, or candidate path: those paths are fixed by the controller and handed to the
participant, never derived from anything the participant returns. Both arms' workspaces are
byte-identical copies of the pristine fixture (git-initialized identically, purely so
`LocalRepositoryIndex`'s `git ls-files` call works for the MAF arm — Native's own context never comes
from that git history). Scoring runs will start from the exact frozen task seeds under
`evaluation/fixtures/phase-b` / `evaluation/fixtures/phase-c`, unchanged from v1.

## 7. Timeout wiring

The frozen 1,800,000ms timeout is wired through `evaluation/experiments/real/lib/agent-session-runner.ts`,
which races the participant's full event stream against a `setTimeout`, not any implicit CLI-side
timeout. On expiry it calls `adapter.cancel(session)` (`SIGTERM` for the real CLI process) and
classifies the run `TIMEOUT`. Both executors classify every run into exactly one of `COMPLETED`,
`TIMEOUT`, `CANCELLED` (not currently distinct from `TIMEOUT` in this executor path — no separate
operator-cancellation channel exists yet for a single benchmark run), or `INFRA_FAILURE` (an adapter
error event with no completion, or a nonzero exit with no completion).

## 8. Budget wiring and its honest limits

See `evaluation/experiments/real/lib/budget-guard.ts`. The frozen $8.00/run HARD ceiling is wired two
ways:

1. **`--max-budget-usd`** — `ClaudeCodeAdapter` already accepted `ClaudeCodeConfig.maxBudgetUsd` and
   forwards it to the CLI as a real flag. Both executors pass the frozen ceiling there. This delegates
   real-time enforcement to the CLI's own internal cost accounting.
2. **Post-hoc comparison** — after a run finishes, `BudgetGuard.finalize()` compares the final
   reported cost against the ceiling (`WITHIN_BUDGET` / `OVER_BUDGET` / `UNKNOWN` when no cost was ever
   observed) and also runs `src/domain/budget.ts` `computeAllocation` for the execution/verification/
   recovery reservation shares, matching `RunService`'s own budget semantics, for the record.

**What is not claimed:** the controller does not itself meter spend during a run and cannot
independently verify the CLI's internal enforcement granularity — a single non-interactive `claude -p`
invocation reports nothing until it exits, so there is no incremental signal for the controller to act
on before that point. `BudgetEnforcementRecord.controllerEnforcesRealTimeCutoff` is hard-coded `false`
specifically so no downstream report can misread this as a controller-owned real-time dollar cutoff.

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

## 10. Provenance schema

`ExperimentProvenanceRecord` (`evaluation/experiments/real/lib/provenance.ts`) extends
`EXPERIMENT_PROTOCOL.md` section 20 with the fields that schema left implicit or that only a real
executor can supply: `resolvedModel`/`resolvedModelStatus`, `timeoutMs`/`timedOut`,
`budget`/`BudgetEnforcementRecord`, per-category `cost`, `candidateWorkspace`, and (MAF only)
`maf: MafInterventionRecord`. Every other field is copied, not re-derived, from the existing audited
pipeline: `NormalizedEvaluationRun` (`hiddenGrader`, `regression`, `regressionEvidence`, `dvs`,
`runValidity`, `effectiveRunValidity`, `candidateIntegrity`, `usage`, `executorSelfReport`,
`infrastructureStatus`).

## 11. NON_SCORING exclusion

`assertNonScoringExcluded` (`evaluation/experiments/real/lib/provenance.ts`) proves structurally, not
just by comment, that a `NON_SCORING` record's `taskId` never collides with the frozen 29-task suite;
`tests/experiment-provenance.test.ts` exercises both the non-colliding and colliding cases. The
preflight fixture lives entirely under `evaluation/experiments/real/fixtures/preflight-phase`, outside
`evaluation/fixtures/phase-b` and `evaluation/fixtures/phase-c`.

## 12. Real-provider preflight command

`npm run experiment:real-preflight` (`evaluation/experiments/run-real-preflight.ts`). Without
`--confirm-billed-run` it validates the v1/v2 manifest equivalence, checks Claude Code CLI availability
with `claude --version` (no model call), builds the synthetic controller-owned workspaces, constructs
the real `NativeExperimentExecutor`/`MafExperimentExecutor`/`CuratorIndependentVerifier` (construction
only — `ClaudeCodeAdapter`'s constructor never spawns anything), prints the planned executions, cleans
up, and stops before any provider invocation, printing `READY_FOR_BILLED_PREFLIGHT`. With
`--confirm-billed-run` it executes exactly one synthetic `NON_SCORING` Native run and one synthetic
`NON_SCORING` MAF run against `evaluation/experiments/real/fixtures/preflight-phase/preflight-task`
only — never a frozen Phase B/C task — and writes
`evaluation/experiments/real/preflight-report.json`.

## 13. Testing

Fake-adapter and fake-CLI tests exist under `tests/` (see `tests/fixtures/fake-agent-adapter.ts`,
`tests/fixtures/fake-signal-collector.ts`, `tests/fixtures/fake-claude-cli.mjs`) and cover: Native fake
success / arm-caused failure / timeout / provider error; MAF fake success / escalation / retry /
non-retryable failure / timeout; adapter mapping correctness against a controlled fake CLI process
(successful transcript, malformed non-JSON line, nonzero exit, hung process + cancellation); budget
propagation and honesty (`UNKNOWN` never becomes `0`); provenance construction including self-report
disagreement, missing candidate, hidden-grader FAIL, regression NOT_CHECKED, and coherence-issue
propagation; NON_SCORING exclusion; and workspace ownership/cleanup.

## 14. No protocol v2 freeze tag yet

`maf-experiment-protocol-v2` is not created by this mission. `validate-manifest-v2.mjs` asserts the
tag does not exist. Protocol v2 cannot freeze until the real billed synthetic preflight
(`--confirm-billed-run`) has actually succeeded — a step explicitly deferred past this mission's
`READY_FOR_BILLED_PREFLIGHT` gate.
