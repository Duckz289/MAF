import {
  isDvs,
  isFalseSafe,
  normalizeEvaluationRun,
  pairedOutcome,
  type EvaluationCostAccounting,
  type EvaluationDurationAccounting,
  type EvaluationMetrics,
  type EvaluationRun,
  type NormalizedEvaluationRun,
  type PairedTaskOutcome,
} from "./types";

// Cost per Durable Verified Success.
//
// The independent audit of snapshot bb326527 found this computed as the mean cost among successful
// runs, which reports the cost of a success while ignoring everything spent failing to get one. For
// two $100 failures and a $1 success the correct figure is $201 per DVS, not $1.
//
// Invalid runs are included in the numerator: excluding them would let an invalid run lower the
// ratio, which protocol cost.invalidRunsImproveCostPerDvs = false forbids.
//
// Unknown cost is never treated as zero. If any in-scope run's cost is unknown, the complete ratio
// is withheld and only a lower bound is offered, alongside the coverage that produced it.
const summarizeCost = (
  runs: NormalizedEvaluationRun[],
  dvsCount: number,
): EvaluationCostAccounting => {
  const known = runs.filter((run) => run.costUsd !== undefined);
  const knownCostUsd = known.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  const coverage = runs.length === 0 ? 0 : known.length / runs.length;
  const complete = runs.length > 0 && known.length === runs.length;
  const lowerBound = dvsCount === 0 ? null : knownCostUsd / dvsCount;
  const status: EvaluationCostAccounting["status"] =
    dvsCount === 0 ? "NO_DVS" : known.length === 0 ? "UNKNOWN" : complete ? "COMPLETE" : "PARTIAL";
  return {
    basis: "ALL_RUNS_IN_SCOPE",
    runsInScope: runs.length,
    runsWithKnownCost: known.length,
    runsWithUnknownCost: runs.length - known.length,
    coverage,
    knownCostUsd,
    costPerDvsUsd: status === "COMPLETE" ? lowerBound : null,
    lowerBoundCostPerDvsUsd: known.length === 0 ? null : lowerBound,
    status,
  };
};

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;

const summarizeDuration = (runs: NormalizedEvaluationRun[]): EvaluationDurationAccounting => {
  const dvsRuns = runs.filter((run) => run.dvs);
  const validRuns = runs.filter((run) => run.effectiveRunValidity === "VALID");
  return {
    meanElapsedOfDvsRunsMs: mean(dvsRuns.map((run) => run.elapsedMs)),
    dvsRunsMeasured: dvsRuns.length,
    meanElapsedOfValidRunsMs: mean(validRuns.map((run) => run.elapsedMs)),
    validRunsMeasured: validRuns.length,
  };
};

export const summarizeEvaluation = (runs: EvaluationRun[]): EvaluationMetrics => {
  const normalized = runs.map(normalizeEvaluationRun);
  const valid = normalized.filter((run) => run.effectiveRunValidity === "VALID");
  const dvsRuns = normalized.filter((run) => run.dvs);
  const falseSafeRuns = normalized.filter((run) => run.falseSafe);
  return {
    runs: normalized.length,
    validRuns: valid.length,
    invalidRuns: normalized.length - valid.length,
    infrastructureFailures: normalized.filter((run) => run.infrastructureFailure).length,
    runsWithCoherenceIssues: normalized.filter((run) => run.coherenceIssues.length > 0).length,
    dvs: dvsRuns.length,
    dvsRateAmongValidRuns: valid.length === 0 ? null : dvsRuns.length / valid.length,
    dvsRateAmongAllRuns: normalized.length === 0 ? null : dvsRuns.length / normalized.length,
    falseSafe: falseSafeRuns.length,
    falseSafeRateAmongValidRuns: valid.length === 0 ? null : falseSafeRuns.length / valid.length,
    cost: summarizeCost(normalized, dvsRuns.length),
    duration: summarizeDuration(normalized),
    paired: [],
  };
};

export const pairEvaluationRuns = (runs: EvaluationRun[]): PairedTaskOutcome[] => {
  const normalized = runs.map(normalizeEvaluationRun);
  const taskIds = [...new Set(normalized.map((run) => run.taskId))].toSorted();
  return taskIds.flatMap((taskId) => {
    const taskRuns = normalized.filter((run) => run.taskId === taskId);
    const native = taskRuns.find((run) => run.condition === "NATIVE");
    const maf = taskRuns.find((run) => run.condition === "MAF");
    if (!native || !maf) return [];
    return [{ taskId, outcome: pairedOutcome(native, maf), native, maf }];
  });
};

export const summarizePairedEvaluation = (runs: EvaluationRun[]): EvaluationMetrics => ({
  ...summarizeEvaluation(runs),
  paired: pairEvaluationRuns(runs),
});

/**
 * A valid run that claims completion must be classified: either it is a Durable Verified Success or
 * it is a false-safe. Anything else means the claim was neither corroborated nor counted.
 */
export const assertIndependentDvs = (run: EvaluationRun): void => {
  if (
    (run.claimedDone || run.claimedTrusted) &&
    run.runValidity === "VALID" &&
    !isDvs(run) &&
    !isFalseSafe(run)
  ) {
    throw new Error(
      "A valid unsuccessful run cannot claim trusted completion without false-safe classification",
    );
  }
};

export type { NormalizedEvaluationRun };
