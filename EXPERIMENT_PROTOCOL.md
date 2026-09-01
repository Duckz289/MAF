# MAF Native-vs-MAF Experimental Protocol v1

Status: **PRE_REGISTERED_NOT_FROZEN**. This document is written before any scoring run of the
frozen 29-task suite. Nothing in it may be edited after scoring begins except by the
change-control procedure in section 20.

Branch: `experiment/native-vs-maf-v1` (from `recovery/post-loss-canonical`).
Manifest: [`evaluation/experiments/native-vs-maf-v1.json`](evaluation/experiments/native-vs-maf-v1.json).

---

## 1. Research question

Does MAF (this repository's adaptive orchestration and independent-verification layer) improve
Durable Verified Success (DVS) relative to the same coding agent running natively, and is that
improvement worth the added cost, latency, and complexity?

A credible result may go any direction: MAF wins substantially, MAF wins only on some task
classes, MAF is too expensive for the DVS gain it produces, MAF is slower but safer, Native is
already sufficient, or MAF produces no measurable improvement. This protocol is designed so that
every one of those outcomes is reachable and none is assumed.

## 2. Frozen suite identity

| Field | Value |
|---|---|
| Tag | `maf-suite-freeze-v1` |
| Commit | `92f13ae67802dd0049ca001f70839a9451120900` |
| Task count | 29 (12 in `evaluation/phase-b`, 17 in `evaluation/phase-c` across band1/band2/band3) |
| Task source of truth | `evaluation/contracts/tasks.json` |
| Membership | Immutable. No task is added, removed, or edited by this protocol. |

`evaluation/experiments/validate-manifest.mjs` checks the manifest's recorded tag/SHA against what
`maf-suite-freeze-v1` resolves to in the live repository, so a suite drift is caught rather than
silently trusted.

## 3. Hypotheses

- **H0 (null):** the MAF arm's DVS rate among valid runs is not different from the Native arm's,
  within the confidence interval computed in section 15.
- **H1:** the MAF arm's DVS rate among valid runs differs from the Native arm's (two-sided; this
  protocol does not pre-commit to the direction).

Secondary, non-primary hypotheses evaluated descriptively, not as a gate on H0/H1:

- MAF's cost-per-DVS and time-to-safe differ from Native's, in either direction.
- Any DVS-rate difference is concentrated in specific task bands (section 16) rather than uniform
  across the suite.

## 4. Arm definitions

### ARM A — NATIVE

The coding agent in its ordinary execution mode with **no** MAF orchestration or intervention:
`benchmarkStrategy: "NATIVE"`, `initialMode`/`finalMode` fixed at `"NATIVE"` (no mode transitions
are possible in this arm — `src/benchmark/runner.ts` `assertAttribution` enforces this whenever a
strategy identity is attached). Native's own artifact is still graded, after the fact, by the same
independent controller-side verification pipeline used for MAF (`src/evaluation/curator-verifier.ts`
`CuratorIndependentVerifier`). Native never receives the hidden grader, the reference
implementation, or any other private curator material — enforced at the fixture level by
`evaluation/curator/leakage-policy.json` and `evaluation/lib/leakage.mjs`, which this protocol does
not modify.

### ARM B — MAF

The same underlying frontier model and effort, running under
`benchmarkStrategy: "MAF_ADAPTIVE"`: MAF's adaptive mode controller
(`src/domain/mode-controller.ts` `AdaptiveModeController`) may transition between `STRICT`,
`GUIDED`, and `SOLO_NATIVE` in response to runtime signals, and the same controller-side
independent verifier runs afterward. The frozen policy dimensions for this arm are recorded in
`evaluation/experiments/native-vs-maf-v1.json` under `arms.MAF.treatmentPolicy`:

| Dimension | Frozen setting |
|---|---|
| Intervention policy | `AdaptiveModeController` default policy, unmodified for this protocol |
| Context strategy | `LocalRepositoryIndex` + `EvidenceRuntimeSignalCollector` default configuration, unmodified |
| Retry policy | Executor-reported `retryCount` only; no MAF-imposed retry ceiling beyond the controller's own mode-driven behavior |
| Verification policy | `CuratorIndependentVerifier`: hidden grader + SMOKE regression, run after participant execution, never observed by the participant |
| Escalation | `STRICT -> GUIDED -> SOLO_NATIVE` per the controller's transition rules; no manual escalation |
| Recovery behavior | `src/domain/recovery.ts` `classifyFailure`-driven provider-transient handling only |
| Model routing | None — identical model/version/effort to Native for every paired run |
| Sandboxing | Same controller-owned, per-run temporary workspace and execution environment as Native |
| Cost controls | `src/domain/budget.ts` HARD allocation mode at the frozen per-run ceiling (section 9) |

Because the controller's mode transitions are adaptive by design, **what is frozen is the policy
that governs those transitions, not any single run's transitions.** A run that ends `SOLO_NATIVE`
after two escalations and a run that stays `GUIDED` throughout are both valid outcomes of the same
frozen policy; the policy itself is what section 20's contamination rule protects.

## 5. Controlled variables

Held identical across both arms for every paired run (`evaluation/experiments/native-vs-maf-v1.json`
`controlledVariables`): model, model version, effort, task prompt, starting repository seed,
budget policy, timeout policy, provider, execution environment, available base tools, and the
hidden grader. The only intended difference between arms is MAF's orchestration/verification
treatment (section 4) — nothing in this list may differ between a paired Native and MAF run.

## 6. MAF treatment

See section 4, ARM B. Restated for emphasis: the treatment under test is MAF's
control/assurance behavior — adaptive mode escalation plus independent controller-side
verification — not a different model, a different effort level, or a different budget. A result
that shows an effect while any row of section 5 differs between arms is not evidence about MAF; it
is a confound, and the run pair is excluded and flagged rather than counted.

## 7. Primary metric

**DVS_RATE_AMONG_VALID_RUNS** — `DVS successes / valid evaluable runs`, using the frozen protocol's
existing definitions verbatim:

- DVS (`src/evaluation/types.ts` `isDvs`): `evidenceSource === "INDEPENDENT"` AND not an
  infrastructure failure AND `runValidity === "VALID"` AND a valid candidate exists AND
  `hiddenGrader === "PASS"` AND `regression === "PASS"`. The participant's own claim
  (`claimedDone`/`claimedTrusted`) is neither necessary nor sufficient.
- Valid run: `effectiveRunValidity === "VALID"` after infrastructure evidence is applied
  (`normalizeEvaluationRun` — downgrade-only, never upgrades a claimed-valid run).

This protocol does not redefine DVS. It is computed by the existing, unmodified pipeline:
`src/evaluation/benchmark-bridge.ts` -> `src/evaluation/metrics.ts` `summarizePairedEvaluation`.

## 8. Secondary metrics

Pre-registered in `evaluation/experiments/native-vs-maf-v1.json` `metrics.secondary`:

`COST_PER_DVS`, `MEAN_ELAPSED_OF_DVS_RUNS_TIME_TO_SAFE`, `INVALID_RUN_RATE`,
`HIDDEN_GRADER_PASS_RATE`, `REGRESSION_PASS_RATE` (smoke-scope only — see section 8.1),
`CANDIDATE_INTEGRITY_FAILURE_RATE`, `FALSE_SAFE_RATE_AMONG_VALID_RUNS`, `MAF_INTERVENTION_COUNT`
(count of `modeTransitions` per MAF run), `RETRY_COUNT`, `EXECUTION_COST_USD`,
`VERIFICATION_COST_USD`, `TOTAL_WALL_CLOCK_DURATION_MS`.

Diagnostic-only metrics (`metrics.diagnostic`): `DVS_RATE_AMONG_ALL_RUNS`,
`MEAN_ELAPSED_OF_VALID_RUNS`, the paired-outcome counts (`BOTH_PASS`, `MAF_ONLY_PASS`,
`NATIVE_ONLY_PASS`, `BOTH_FAIL`, `INVALID_MAF`, `INVALID_NATIVE`, `INVALID_BOTH`), and
`COHERENCE_ISSUES_COUNT`.

No metric is promoted from diagnostic to primary, or the reverse, after results are seen (section
17).

### 8.1 What `REGRESSION_PASS_RATE` does and does not establish

The frozen protocol's regression check is a **smoke** check — every shipped module loads, every
public entrypoint runs to a clean exit — not a full behavioral regression suite
(`evaluation/protocol.json` `verification.regression`, `RegressionEvidenceScope` in
`src/evaluation/independent-verification.ts`). Audit #3 reproduced, on real fixtures, a candidate
that correctly fixes the graded behavior while silently breaking an unrelated, unexercised exported
function and still reaches `regression: PASS`. This protocol reports `REGRESSION_PASS_RATE` under
that same scope and coverage; it is never read as "no regressions," only as "no smoke-detectable
regression."

## 9. Cost definition

**`costPerDvs = total relevant measured cost / DVS count`** (`evaluation/protocol.json`
`cost.costPerDvsDefinition`, unmodified). Total cost is the sum, over every in-scope run —
including invalid and failed runs — of:

- participant/model cost (`EvaluationRun.costUsd`, sourced from the executor's reported usage);
- MAF orchestration/model cost, where the orchestration layer itself makes model calls (none in
  this repository's current `AdaptiveModeController` — it is signal-driven, not LLM-driven — so
  this term is `$0` unless a future MAF revision adds LLM-based orchestration decisions, at which
  point it must be captured the same way);
- verification-model cost — `$0` for this protocol, because `CuratorIndependentVerifier`'s hidden
  grader and regression check are deterministic Node processes, not LLM calls (see section 8.1);
- tool/runtime cost, where measured.

Failed runs are never excluded from the numerator (`cost.invalidRunsImproveCostPerDvs = false`):
excluding them would let an invalid run make the ratio look better. Unknown cost is never treated
as zero; if any in-scope run's cost is unknown, only a lower-bound `costPerDvs` is reported
alongside its coverage fraction, exactly as `src/evaluation/metrics.ts` `summarizeCost` already
computes it. This protocol adds no new cost semantics — it names the existing ones as the frozen
answer to "what does cost mean here."

### 9.1 Per-run budget ceiling and its derivation

Frozen: **$8.00 per participant run, HARD mode** (`src/domain/budget.ts` `computeAllocation` /
`authorizeSpend`), identical for both arms.

Using Claude Sonnet 5's published per-token pricing ($2.00 / MTok input, $10.00 / MTok output — the
model this protocol resolves to, section 11) and an estimated per-run token profile of roughly
80K input / 8K output tokens for Native and 120K input / 10K output tokens for MAF (MAF's context
strategy and verification bookkeeping is expected to add input-token overhead; this is an estimate,
not a measurement — see section 15), the **expected** cost per run is on the order of $0.24
(Native) to $0.34 (MAF). The $8 ceiling is roughly 25-30x that expectation: generous enough to
absorb a verbose or retried run without truncating it mid-task, while still bounding the absolute
worst case for the whole scoring run (174 runs x $8 = $1,392) to a number small enough to sanity-
check against provider billing before it can silently run away.

## 10. Time-to-safe definition

**Start:** participant execution start (the moment the executor's own clock begins — the same
instant `BenchmarkExecution.latencyMs` is measured from in `src/benchmark/runner.ts` and
`benchmarks/fixture-executor.ts`'s `performance.now()` pattern).

**End (safe result established):** the moment independent verification reaches either (a)
sufficient evidence for a DVS — `hiddenGrader: PASS` and `regression: PASS` from
`CuratorIndependentVerifier`, i.e. `evidenceSource: INDEPENDENT` fully resolved — or (b) a
definitive non-DVS classification (`hiddenGrader: FAIL`, or `candidateIntegrity` resolving to
`INVALID`/`MISSING`, or an infrastructure failure). **"The agent says done" is explicitly not the
end-of-timing event** — `claimedDone`/`claimedTrusted` are self-reported and are recorded but never
used to stop the clock (`src/evaluation/independent-verification.ts`
`participantSelfReportIsNotVerification`).

Reported as `MEAN_ELAPSED_OF_DVS_RUNS_TIME_TO_SAFE`, using the existing
`meanElapsedOfDvsRunsMs` field (`EvaluationDurationAccounting`) — named for exactly what it
measures: DVS runs only, so it is contrasted with, never substituted for,
`meanElapsedOfValidRunsMs` across all valid runs regardless of outcome.

**Timeout handling:** a run that has not reached a terminal execution status within
`timeoutMs = 1,800,000` (30 minutes, section 11) is classified `TIMEOUT`, which
`isInfrastructureFailure` makes `effectiveRunValidity: INVALID` and `dvs: false` regardless of any
partial progress or self-report. It is reported under `INVALID_RUN_RATE`, not folded into
time-to-safe.

## 11. Task population

All 29 tasks in the frozen suite (`evaluation/contracts/tasks.json`), spanning phase-b (12 tasks)
and phase-c bands 1-3 (5 + 7 + 5 tasks). No task is excluded, added, or reweighted.

**Model configuration** (`evaluation/experiments/native-vs-maf-v1.json` `modelConfiguration`,
resolved, not a placeholder):

| Field | Value |
|---|---|
| Model | `claude-sonnet-5` |
| Provider | `anthropic` |
| Effort | `high` |
| Thinking | adaptive |

This resolves the mission's model/effort assignment (Claude Sonnet 5, High effort) as the frozen
participant configuration for **both** arms of every paired run — not just as the model running
this protocol-design session.

**Timeout:** 1,800,000 ms (30 minutes) per participant run — distinct from, and applied on top of,
the local ABI grader/regression timeouts that already exist for fast deterministic fixture checks
(`evaluation/protocol.json` `execution.timeoutMs = 120000`;
`CuratorIndependentVerifier`'s own `DEFAULT_GRADER_TIMEOUT_MS = 30000` and
`DEFAULT_REGRESSION_TIMEOUT_MS = 20000`, which run after participant timing has already stopped).

**Budget:** $8.00 per run, HARD mode (section 9.1).

## 12. Pairing

Every one of the 29 tasks is run under **both** arms — a Native run and a MAF run per task per
repetition — so every comparison is paired by task (`evaluation/protocol.json`
`analysis.pairedByTask`, unmodified; `src/evaluation/metrics.ts` `pairEvaluationRuns` matches runs
by `taskId` and requires both a `NATIVE` and a `MAF` run to exist before producing a
`PairedTaskOutcome`).

## 13. Randomization

Counterbalanced: for each task, which arm runs first is fixed in advance by a deterministic,
reproducible seed — never "MAF always second" or any other systematic order.

- **Seed:** `maf-experiment-protocol-v1-native-vs-maf-2026-09-01`
  (`evaluation/experiments/generate-randomization.mjs` `RANDOMIZATION_SEED`).
- **Method:** an `xmur3`-seeded `mulberry32` PRNG Fisher-Yates-shuffles the 29 frozen task IDs into
  `taskOrder`; `armOrder` is derived from shuffled-position parity (even index -> `NATIVE_FIRST`,
  odd index -> `MAF_FIRST`), giving an exact 15/14 counterbalance rather than leaving the split to
  chance.
- **Frozen output:** [`evaluation/experiments/randomization.json`](evaluation/experiments/randomization.json)
  — `seed`, `taskOrder`, and `armOrder`, generated and committed **before** any scoring execution.
- **Reproducibility:** `node evaluation/experiments/generate-randomization.mjs --check` regenerates
  the file from the seed and the current frozen task list and fails if it does not match
  byte-for-byte; `evaluation/experiments/validate-manifest.mjs` runs the same check.

## 14. Run-count decision

**Frozen: N = 3 repetitions per task per arm.** 29 tasks x 2 arms x 3 = **174 total participant
runs.**

### 14.1 Scenarios considered

| N | Total runs | Expected cost (Sonnet 5, section 9.1 estimate) | Expected wall-clock (sequential, 30 min ceiling) |
|---|---|---|---|
| N=1 | 58 | ~$17 | up to ~29 hours worst case; ~4-6 hours expected at typical per-run duration well under the timeout |
| N=3 | 174 | ~$50 | up to ~87 hours worst case; ~12-18 hours expected |
| N=5 | 290 | ~$84 | up to ~145 hours worst case; ~20-30 hours expected |

Expected-cost figures use the same per-run token estimate as section 9.1 and are explicitly
**estimates, not measurements** — this protocol has not executed any frontier scoring run
(`FRONTIER_SCORING_RUNS_EXECUTED: NO`). Real per-run token consumption could plausibly be 0.5x-3x
this estimate depending on repository size, task difficulty, and how often MAF's adaptive
controller escalates; the $8/run HARD budget ceiling (section 9.1) bounds the downside regardless
of where in that range actual usage lands. Wall-clock figures assume runs within a task-arm pair
can be parallelized across tasks (the runner has no cross-task dependency) but are conservative
about within-task-arm sequencing.

### 14.2 Rationale for N=3

- **Stochasticity:** a single run (N=1) cannot distinguish "this arm is worse on this task" from
  "this run happened to fail." N=3 allows a task-level majority aggregate (section 15.1) to smooth
  a single outlier run without requiring N=5's cost.
- **Consistency with existing practice:** N=3 matches `evaluation/protocol.json`
  `execution.repetitions`, the repetition count already used for local ABI/determinism stress
  validation of this same suite — reusing a number this codebase has already validated as
  operationally reasonable, rather than picking a new one with no local precedent.
- **Budget:** at the estimated ~$0.29 blended per-run cost, N=3's ~$50 expected total is a small,
  easily pre-approved figure; N=5's ~$84 buys proportionally less additional statistical power
  than the jump from N=1 to N=3 does.
- **Runtime:** N=3 is large enough to support the paired statistical plan in section 15 without
  requiring multi-day wall-clock time if runs are executed with reasonable parallelism across
  tasks.

N=5 is the documented fallback if N=3's task-level results turn out noisier than expected (a
protocol v2 decision, made under section 20's change-control procedure — never a silent
mid-experiment increase).

## 15. Statistical plan

### 15.1 Task-level aggregation (before global aggregation)

Because 3 runs are nested inside each task-arm cell, they are aggregated to one task-level result
per arm **before** any cross-task pooling, so repeated stochastic runs of the same task are never
treated as 3 independent data points in the paired analysis:

- **Task-level DVS:** an arm's 3 repetitions for a task collapse to a single task-level outcome by
  majority vote (>=2 of 3 DVS -> task-level DVS=true). A 3-way split cannot occur with an odd N.
- **Task-level invalid:** if all 3 repetitions for an arm are invalid, the task-arm cell is
  `INVALID_BOTH`/`INVALID_NATIVE`/`INVALID_MAF` per `pairedOutcome`'s existing classification,
  applied to the majority-aggregated cell rather than to a single run.
- **Task-level cost/duration:** mean across the (up to 3) valid repetitions for that task-arm cell,
  computed with the same "unknown cost is never zero" rule as section 9.

### 15.2 Global aggregation and reporting

- **Aggregate DVS rate** per arm: task-level DVS successes / task-level valid cells
  (`DVS_RATE_AMONG_VALID_RUNS`, computed over the 29 task-level cells per arm, not over the 174 raw
  runs).
- **Paired win/loss/tie counts:** for each of the 29 tasks, classify the task-level pair as
  `BOTH_PASS`, `MAF_ONLY_PASS`, `NATIVE_ONLY_PASS`, `BOTH_FAIL`, or one of the invalid variants
  (`pairedOutcome`, applied post-aggregation).
- **Absolute DVS-rate difference:** MAF aggregate rate minus Native aggregate rate, in percentage
  points.
- **Relative improvement:** `(MAF rate - Native rate) / Native rate`, reported only when the Native
  rate is non-zero (an undefined ratio is reported as `N/A`, never as `0%` or `∞`).
- **Cost/DVS difference and time-to-safe difference:** MAF minus Native, using the section 9 and
  section 10 definitions, computed on the task-level aggregates from 15.1.

### 15.3 Inference

Because outcomes are paired by task, use a **paired, non-parametric test on the task-level
win/loss/tie counts** — McNemar's test on the `MAF_ONLY_PASS` vs `NATIVE_ONLY_PASS` counts (the
discordant pairs; `BOTH_PASS` and `BOTH_FAIL` are concordant and uninformative to the paired
comparison) — rather than an unpaired two-proportion test, since task difficulty varies enough
across the suite's bands (section 16) that pooling across tasks without pairing would confound
task difficulty with arm effect. Report the exact binomial p-value on the discordant pairs
(appropriate at this sample size — up to 29 discordant pairs) alongside a Wilson score 95%
confidence interval on the aggregate DVS-rate difference. This is deliberately a simple,
implementable design over a more elaborate model: with 29 paired tasks, a mixed-effects model would
be over-fit relative to the available data.

## 16. Subgroup (band / task-class) analyses

Pre-registered, **secondary**, computed identically to section 15 but restricted to each subgroup;
never used to redefine or replace the primary aggregate result:

- `phase-b` (12 tasks: SIMPLE_TASK, LOCAL_BUGFIX, MULTI_FILE_FEATURE, CROSS_MODULE_BUG,
  CODEBASE_ORIENTATION, REGRESSION_REPAIR, AMBIGUOUS_REQUIREMENT, RISK_SENSITIVE_CHANGE,
  RECOVERY_TASK categories per `evaluation/phase-b/manifest.json`)
- `phase-c:band1` (5 tasks — mechanical edits: extend-exhaustive-union, mirror-pure-utility-fn,
  mirror-sibling-guard-clause, rename-exported-symbol, string-pad-length-bug)
- `phase-c:band2` (7 tasks — state/consistency-sensitive: tenant-bypass, lost-update,
  terminal-leak, migration-loss, partial-validation-mutation, aggregate-consistency,
  pending-write-visibility)
- `phase-c:band3` (5 tasks — context/orientation-sensitive regressions, subject to the Band 3
  orientation audit already required by `evaluation/phase-c/manifest.json`
  `band3OrientationAudit`)

Task labels and band membership are exactly `evaluation/contracts/tasks.json`'s existing `band`
field and are not reassigned after results are seen (section 17).

## 17. Invalid-run policy

Unmodified from `evaluation/protocol.json` `invalidRuns`: invalid runs never count toward DVS
(`countAsDvs: false`) and are always reported separately from the valid-run denominator
(`reportedSeparately: true`), never silently dropped.

### 17.1 Model/arm failure vs. experiment infrastructure failure

| Category | Examples | Treatment |
|---|---|---|
| **Model/arm failure** (the arm's own behavior) | participant produces a candidate the hidden grader FAILs; participant crashes on its own logic; participant never produces a candidate | A **valid run with a non-DVS outcome**. Counted fully, in both the DVS denominator and the cost numerator. **Never rerun.** |
| **Experiment infrastructure failure** (the harness, not the arm) | provider outage; quota exhaustion; tool/runner crash; workspace materialization failure; verifier unavailable; timeout caused by infrastructure rather than the participant's own runaway behavior | `executionStatus` in `{INFRA_FAILURE, TIMEOUT, CANCELLED, QUOTA_EXHAUSTED}` or a `providerError`/`infrastructureError` present (`isInfrastructureFailure`, unmodified). Invalid, excluded from the valid-run denominator. **May be rerun** under 17.2. |

`candidateMissing`, `graderINVALID`, and `verificationUnavailable` (`evidenceSource: NOT_CHECKED`)
are treated as **experiment infrastructure failure** when the cause is the harness (workspace
allocation, verifier crash) and as **model/arm failure** when the cause is the participant (it
never wrote a candidate at all). The distinguishing evidence is `CandidateArtifactEvidence` — a
missing workspace is infrastructure; a workspace that exists but the participant left unchanged is
the participant's own outcome.

### 17.2 Rerun policy

**Only** runs classified as experiment infrastructure failure may be rerun; an ordinary arm failure
is never rerun, however unlucky it looks, because rerunning until an arm succeeds would bias the
DVS rate upward for whichever arm gets rerun more often. When a rerun happens:

- the original run record is preserved in the log (never overwritten or deleted);
- the rerun is a new run record referencing the original's `runId` as its predecessor;
- the rerun still counts against the frozen N (it replaces the infrastructure-failed slot, it does
  not add an extra one) unless the budget/stopping rules in section 18 make that impossible, in
  which case the task-arm cell is reported with reduced N and that reduction is disclosed, not
  hidden.

## 18. Stopping rules

Pre-registered before any result is seen:

- **Fixed N, no early stopping on trend.** All 174 planned runs execute; the run is never stopped
  early because an aggregate difference favoring either arm appears partway through.
- **Stop only for:** a safety/integrity failure (private-material leakage, nondeterminism,
  candidate-integrity violation — the same conditions `evaluation/protocol.json`
  `execution.stoppingRule` already uses for local validation), a provider outage that exceeds a
  reasonable retry window, or the budget ceiling (174 x $8 = $1,392 absolute maximum) being
  reached.
- **No mid-run change to N, timeout, budget, or the statistical plan** based on interim results —
  any such change is a protocol v2 decision under section 20, made and documented before scoring
  resumes, never applied retroactively to already-collected data.

## 19. Experiment contamination / change-control rule

Once scoring begins, the following are frozen and may not change: benchmark suite membership,
graders, MAF policy, Native configuration, model/version, effort, timeout, task prompts, run
count, and the statistical plan (section 15).

If a material defect is discovered mid-run:

1. **Stop** the affected experiment (the specific task-arm cells implicated, or the whole run if
   the defect is systemic).
2. **Record an incident**: what was found, which runs it affects, and whether those runs' data is
   usable, quarantined, or discarded.
3. **Classify the defect.** A benchmark defect (a grader bug, a leaked fixture, a broken pristine
   seed) produces a **suite v2** with its own tag, distinct from `maf-suite-freeze-v1`. A protocol
   defect (a wrong metric formula, a broken randomization, a budget that turns out too tight) produces
   a **protocol v2**, distinct from this document's frozen version.
4. **Never silently continue under changed rules.** Runs collected before the fix and runs
   collected after it are never pooled as if the rules had not changed.

## 20. Provenance / log schema

Every scoring run records, at minimum (fields already produced by the existing pipeline plus the
experiment-specific fields this protocol adds):

| Field | Source |
|---|---|
| `experimentProtocolVersion` | this document's version (`1.0.0-preregistered` until frozen) |
| `suiteTag`, `suiteSha` | `evaluation/experiments/native-vs-maf-v1.json` `frozenSuite` |
| `taskId` | `EvaluationRun.taskId` |
| `arm` (condition) | `EvaluationRun.condition` (`NATIVE` \| `MAF`) |
| `runNumber` (1-3) | assigned at execution time, preserved on rerun (section 17.2) |
| `randomizationPosition` / `armOrder` | `evaluation/experiments/randomization.json` |
| `model`, `modelVersion` | `EvaluationRun.model` |
| `effort` | `evaluation/experiments/native-vs-maf-v1.json` `modelConfiguration.effort` |
| `provider` | `EvaluationRun.provider` |
| `startTimestamp` / `endTimestamp` | executor-reported start + verification-complete time (section 10) |
| `timeoutMs`, `budgetUsd` | manifest-frozen values (section 11) |
| `candidateRevision` / `candidateId` | `EvaluationRun.sourceRevision`, sample `candidateId` |
| `executorSelfReport` | `EvaluationRun.selfReported` (recorded, never trusted — section 7) |
| `independentVerificationEvidence` | `IndependentVerificationResult` (candidateIntegrity, hiddenGrader, regression, regressionEvidence, notes) |
| `dvs` | `NormalizedEvaluationRun.dvs` |
| `cost` | `EvaluationRun.costUsd` / `usage`, with `costStatus` |
| `duration` | `EvaluationRun.elapsedMs` |
| `mafInterventions` | count of `modeTransitions` (MAF arm only) |
| `retries` | `EvaluationRun` retry/verification/repair attempt counts |
| `infrastructureClassification` | `NormalizedEvaluationRun.infrastructureFailure`, `coherenceIssues` |

This is sufficient to reconstruct exactly what happened for any run without re-executing it, per
the mission's provenance requirement.

## 21. Dry-run exclusion

The NON_SCORING dry run (`evaluation/experiments/run-dry-run.ts`, fixture under
`evaluation/experiments/dry-run/`) exists solely to verify runner plumbing — workspace creation,
Native and MAF arm launch, independent verification, cost/duration recording, DVS/report
serialization, cleanup, and paired-result generation — using a synthetic task never drawn from the
frozen 29-task suite. Its output (`evaluation/experiments/dry-run/report.json`) is tagged
`status: "NON_SCORING"`, `tag: "NOT_PART_OF_EXPERIMENT"` and is excluded from every metric,
statistic, and figure in this protocol by construction: it is not one of the 29 `taskId`s, so
`pairEvaluationRuns` and every downstream aggregate in section 15 cannot include it even if its
record were accidentally merged into a results set.

## 22. Known limitations

- **Regression evidence is smoke-scope, not behavioral** (section 8.1) — a DVS under this protocol
  proves the hidden grader's specific assertions pass and nothing shipped fails to load or run its
  entrypoint; it does not prove the absence of regressions outside that scope. `REGRESSION_PASS_RATE`
  is reported with that caveat attached, never as "no regressions."
- **Cost estimates in sections 9.1 and 14.1 are unmeasured.** No frontier scoring run has executed
  under this protocol (`FRONTIER_SCORING_RUNS_EXECUTED: NO`); real per-run token consumption is not
  yet known and could differ from the stated estimate by a material factor. The $8/run HARD budget
  bounds the downside; it does not make the estimate accurate.
- **N=3 is a compromise, not a power calculation.** With 29 tasks and N=3, the paired test in
  section 15.3 has limited power to detect a small DVS-rate difference; a null result at this N is
  evidence of "no large effect detected," not proof of no effect. N=5 is the documented fallback
  (section 14.2) if a v2 protocol is warranted.
- **MAF's orchestration is currently signal-driven, not LLM-driven** (`AdaptiveModeController` has
  no model calls of its own), so `VERIFICATION_COST_USD`/orchestration cost is `$0` in this
  protocol version. A future MAF revision that adds LLM-based orchestration decisions would need a
  protocol v2 to capture that cost correctly — this version would silently undercount it.
- **Task population is 29 tasks from one reconstruction of one benchmark generation.** Results are
  specific to this suite's task mix and difficulty distribution and are not a general claim about
  MAF's effect on arbitrary coding tasks outside it.
- **Same-model requirement is a design choice, not a completeness claim.** This protocol
  deliberately does not test whether MAF's benefit (if any) changes under a different model tier;
  that is out of scope for v1 and would need its own controlled comparison.

---

## Appendix: file map

| Artifact | Path |
|---|---|
| This document | `EXPERIMENT_PROTOCOL.md` |
| Machine-readable manifest | `evaluation/experiments/native-vs-maf-v1.json` |
| Randomization generator | `evaluation/experiments/generate-randomization.mjs` |
| Frozen randomization output | `evaluation/experiments/randomization.json` |
| Manifest validator (deterministic, no frontier calls) | `evaluation/experiments/validate-manifest.mjs` |
| NON_SCORING dry-run runner | `evaluation/experiments/run-dry-run.ts` |
| NON_SCORING dry-run fixture | `evaluation/experiments/dry-run/fixtures/dry-run-phase/dry-run-task/` |
| NON_SCORING dry-run grader | `evaluation/experiments/dry-run/curator/dry-run-phase/dry-run-task/grader.mjs` |
| NON_SCORING dry-run last report | `evaluation/experiments/dry-run/report.json` |
