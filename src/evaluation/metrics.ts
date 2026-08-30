import {
  isDvs,
  isFalseSafe,
  normalizeEvaluationRun,
  pairedOutcome,
  type EvaluationMetrics,
  type EvaluationRun,
  type NormalizedEvaluationRun,
  type PairedTaskOutcome,
} from "./types";

export const summarizeEvaluation = (runs: EvaluationRun[]): EvaluationMetrics => {
  const normalized = runs.map(normalizeEvaluationRun);
  const dvsRuns = normalized.filter((run) => run.dvs);
  const costs = dvsRuns.flatMap((run) => (run.costUsd === undefined ? [] : [run.costUsd]));
  return {
    runs: normalized.length,
    validRuns: normalized.filter((run) => run.runValidity === "VALID").length,
    dvs: dvsRuns.length,
    dvsRate: normalized.length === 0 ? 0 : dvsRuns.length / normalized.length,
    falseSafe: normalized.filter((run) => run.falseSafe).length,
    falseSafeRate: normalized.length === 0 ? 0 : normalized.filter((run) => run.falseSafe).length / normalized.length,
    knownCostDvs: costs.length,
    costPerDvsUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0) / costs.length,
    timeToSafeMs: dvsRuns.length === 0 ? null : dvsRuns.reduce((sum, run) => sum + run.elapsedMs, 0) / dvsRuns.length,
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

export const summarizePairedEvaluation = (runs: EvaluationRun[]): EvaluationMetrics => {
  const summary = summarizeEvaluation(runs);
  return { ...summary, paired: pairEvaluationRuns(runs) };
};

export const assertIndependentDvs = (run: EvaluationRun): void => {
  if (run.claimedDone && isDvs(run) === false && run.runValidity === "VALID" && !isFalseSafe(run)) {
    throw new Error("A valid unsuccessful run cannot claim trusted completion without false-safe classification");
  }
};

export type { NormalizedEvaluationRun };
