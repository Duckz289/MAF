// Protocol v2 experiment provenance schema.
//
// Every field the mission's PROVENANCE_SCHEMA section requires, built by merging three things that
// already exist for good reasons and should not be re-derived by hand:
//
//   1. NormalizedEvaluationRun  (src/evaluation/types.ts)      -- hiddenGrader/regression/dvs/
//                                                                  runValidity/cost/usage, produced
//                                                                  by the real, audited
//                                                                  evaluateBenchmarkSamples pipeline.
//   2. BenchmarkSample           (src/benchmark/runner.ts)      -- runId/candidateId/modeTransitions/
//                                                                  signalSnapshots.
//   3. ExecutorSideChannel (this experiment's own executors)    -- everything BenchmarkExecution has
//                                                                  no field for: resolvedModel status,
//                                                                  effort, timeout/budget wiring,
//                                                                  per-category cost breakdown, and
//                                                                  MAF intervention/escalation counts.
//
// This module never invents a value: every field is either copied from one of the three sources
// above or explicitly marked UNKNOWN.

import type { NormalizedEvaluationRun } from "../../../../src/evaluation/types";

export type ResolvedModelStatus = "RESOLVED" | "ALIAS_ONLY";
export type ScoringStatus = "NON_SCORING" | "SCORING";
export type CostFieldStatus = "KNOWN" | "PARTIAL" | "UNKNOWN";

export interface BudgetEnforcementRecord {
  mode: "HARD";
  limitUsd: number;
  /**
   * What actually enforces the ceiling. `CLI_INTERNAL_MAX_BUDGET_FLAG`: the controller passes
   * `--max-budget-usd` to the Claude Code CLI and relies on the CLI's own internal accounting to
   * stop the session; the controller cannot independently verify the CLI's internal enforcement
   * granularity. `POST_HOC_DETECTION_ONLY`: no incremental enforcement is available at all (e.g. a
   * fake/test adapter that does not support the flag) and the controller can only compare the
   * final reported cost against the ceiling after the run has already finished.
   */
  enforcementMechanism: "CLI_INTERNAL_MAX_BUDGET_FLAG" | "POST_HOC_DETECTION_ONLY";
  /** Always false: nothing in this design independently meters spend mid-run. Stated explicitly so
   *  no report can be misread as claiming a real-time dollar cutoff the controller itself enforces. */
  controllerEnforcesRealTimeCutoff: false;
  postHocStatus: "WITHIN_BUDGET" | "OVER_BUDGET" | "UNKNOWN";
  limitation: string;
}

export interface TimeoutRecord {
  timeoutMs: number;
  timedOut: boolean;
}

export interface CostBreakdown {
  participantCostUsd: number | null;
  participantInputTokens: number;
  participantOutputTokens: number;
  participantCacheTokens: number | null;
  orchestrationCostUsd: number | null;
  verificationCostUsd: number | null;
  totalCostUsd: number | null;
  costStatus: CostFieldStatus;
  note?: string;
}

export interface MafInterventionRecord {
  mode: { initial: string; final: string };
  interventions: number;
  retries: number;
  escalations: number;
  transitions: Array<{
    from: string;
    to: string;
    reason: string;
    enforcementMethod: string;
    enforcementNote: string;
  }>;
}

/** Everything an executor knows about its own run that has no field on the frozen
 *  `BenchmarkExecution` contract. Keyed by the `runId` the executor also put on its sample. */
export interface ExecutorSideChannel {
  requestedModel: string;
  resolvedModel: string | null;
  resolvedModelStatus: ResolvedModelStatus;
  effort: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  timeout: TimeoutRecord;
  budget: BudgetEnforcementRecord;
  cost: CostBreakdown;
  candidateWorkspace: string;
  maf?: MafInterventionRecord;
}

export interface ExperimentProvenanceRecord {
  protocolVersion: 2;
  protocolTag: string;
  protocolSha: string;
  suiteTag: string;
  suiteSha: string;
  scoringStatus: ScoringStatus;
  taskId: string;
  arm: "NATIVE" | "MAF";
  runNumber: number;
  randomizationPosition: number | null;
  requestedModel: string;
  resolvedModel: string | null;
  resolvedModelStatus: ResolvedModelStatus;
  effort: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  budgetUsd: number;
  budget: BudgetEnforcementRecord;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  cost: CostBreakdown;
  candidateWorkspace: string;
  executorSelfReport: NormalizedEvaluationRun["selfReported"];
  candidateIntegrity: NormalizedEvaluationRun["candidateIntegrity"];
  hiddenGrader: NormalizedEvaluationRun["hiddenGrader"];
  regression: NormalizedEvaluationRun["regression"];
  regressionEvidence: NormalizedEvaluationRun["regressionEvidence"];
  runValidity: NormalizedEvaluationRun["runValidity"];
  effectiveRunValidity: NormalizedEvaluationRun["effectiveRunValidity"];
  infrastructureStatus: {
    executionStatus: NormalizedEvaluationRun["executionStatus"];
    infrastructureFailure: boolean;
    providerError?: string;
    infrastructureError?: string;
    coherenceIssues: string[];
  };
  dvs: boolean;
  maf?: MafInterventionRecord;
}

export const buildProvenanceRecord = (input: {
  scoringStatus: ScoringStatus;
  protocolTag: string;
  protocolSha: string;
  suiteTag: string;
  suiteSha: string;
  runNumber: number;
  randomizationPosition: number | null;
  arm: "NATIVE" | "MAF";
  normalized: NormalizedEvaluationRun;
  side: ExecutorSideChannel;
}): ExperimentProvenanceRecord => {
  const { normalized, side } = input;
  return {
    protocolVersion: 2,
    protocolTag: input.protocolTag,
    protocolSha: input.protocolSha,
    suiteTag: input.suiteTag,
    suiteSha: input.suiteSha,
    scoringStatus: input.scoringStatus,
    taskId: normalized.taskId,
    arm: input.arm,
    runNumber: input.runNumber,
    randomizationPosition: input.randomizationPosition,
    requestedModel: side.requestedModel,
    resolvedModel: side.resolvedModel,
    resolvedModelStatus: side.resolvedModelStatus,
    effort: side.effort,
    provider: side.provider,
    startedAt: side.startedAt,
    finishedAt: side.finishedAt,
    durationMs: Math.max(0, Date.parse(side.finishedAt) - Date.parse(side.startedAt)),
    timeoutMs: side.timeout.timeoutMs,
    timedOut: side.timeout.timedOut,
    budgetUsd: side.budget.limitUsd,
    budget: side.budget,
    usage: {
      inputTokens: normalized.usage?.inputTokens ?? 0,
      outputTokens: normalized.usage?.outputTokens ?? 0,
      cachedTokens: normalized.usage?.cachedTokens ?? 0,
    },
    cost: side.cost,
    candidateWorkspace: side.candidateWorkspace,
    executorSelfReport: normalized.selfReported,
    candidateIntegrity: normalized.candidateIntegrity,
    hiddenGrader: normalized.hiddenGrader,
    regression: normalized.regression,
    regressionEvidence: normalized.regressionEvidence,
    runValidity: normalized.runValidity,
    effectiveRunValidity: normalized.effectiveRunValidity,
    infrastructureStatus: {
      executionStatus: normalized.executionStatus,
      infrastructureFailure: normalized.infrastructureFailure,
      ...(normalized.providerError ? { providerError: normalized.providerError } : {}),
      ...(normalized.infrastructureError
        ? { infrastructureError: normalized.infrastructureError }
        : {}),
      coherenceIssues: normalized.coherenceIssues,
    },
    dvs: normalized.dvs,
    ...(side.maf ? { maf: side.maf } : {}),
  };
};

/**
 * Structural proof that a NON_SCORING record can never enter a scoring aggregate: scoring
 * aggregation (src/evaluation/benchmark-bridge.ts summarizePairedEvaluation, gated through
 * evaluation/experiments/validate-manifest*.mjs task-id membership) only ever sees records whose
 * `taskId` is one of the frozen 29 suite task IDs. A NON_SCORING record's `taskId` is asserted here
 * to never collide with that set, so even an accidental merge cannot silently count it.
 */
export const assertNonScoringExcluded = (
  record: ExperimentProvenanceRecord,
  frozenTaskIds: readonly string[],
): void => {
  if (record.scoringStatus !== "NON_SCORING") return;
  if (frozenTaskIds.includes(record.taskId)) {
    throw new Error(
      `NON_SCORING provenance record uses taskId "${record.taskId}", which collides with the frozen scoring suite`,
    );
  }
};
