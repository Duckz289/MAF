import type { BenchmarkStrategy } from "../benchmark/runner";

// Evaluation protocol semantics (evaluation/protocol.json, version 2.0.0-reconstructed).
//
// The independent audit of snapshot bb326527 found these semantics documented but unwired, and the
// accounting defective:
//
//  * isDvs did not consider infrastructure failure, so a TIMEOUT whose other fields said VALID was
//    counted as a Durable Verified Success.
//  * pairedOutcome short-circuited to INVALID_NATIVE when both arms were invalid, so a
//    both-invalid pair was indistinguishable from a native-only-invalid one.
//  * Nothing validated incoherent field combinations, so malformed upstream state propagated.
//
// The rule this file enforces: a run's classification may be downgraded by evidence, never upgraded
// by the absence of it.

export type EvaluationCondition = "NATIVE" | "MAF";
export type ExecutionStatus =
  | "COMPLETED"
  | "INFRA_FAILURE"
  | "TIMEOUT"
  | "CANCELLED"
  | "QUOTA_EXHAUSTED";
export type CandidateIntegrity = "VALID" | "INVALID" | "MISSING" | "UNKNOWN";
export type RunValidity = "VALID" | "INVALID";
export type EvidenceOutcome = "PASS" | "FAIL" | "UNKNOWN";
export type CostStatus = "KNOWN" | "PARTIAL" | "UNKNOWN";
export type PairedOutcome =
  | "BOTH_PASS"
  | "MAF_ONLY_PASS"
  | "NATIVE_ONLY_PASS"
  | "BOTH_FAIL"
  | "INVALID_MAF"
  | "INVALID_NATIVE"
  | "INVALID_BOTH";

export interface EvaluationRun {
  runId: string;
  condition: EvaluationCondition;
  model: string;
  provider: string;
  taskId: string;
  executionStatus: ExecutionStatus;
  candidateExists: boolean;
  candidateIntegrity: CandidateIntegrity;
  runValidity: RunValidity;
  hiddenGrader: EvidenceOutcome;
  regression: EvidenceOutcome;
  claimedDone: boolean;
  claimedTrusted: boolean;
  elapsedMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  costUsd?: number;
  providerError?: string;
  infrastructureError?: string;
  sourceRevision: string;
}

export interface NormalizedEvaluationRun extends EvaluationRun {
  costStatus: CostStatus;
  dvs: boolean;
  infrastructureFailure: boolean;
  falseSafe: boolean;
  /** Run validity after infrastructure evidence is applied. Never upgrades the reported value. */
  effectiveRunValidity: RunValidity;
  /** Incoherent field combinations found while normalizing. Non-empty means the upstream payload
   *  contradicted itself and was downgraded rather than trusted. */
  coherenceIssues: string[];
}

export interface PairedTaskOutcome {
  taskId: string;
  outcome: PairedOutcome;
  native: NormalizedEvaluationRun;
  maf: NormalizedEvaluationRun;
}

export interface EvaluationCostAccounting {
  /** What the numerator covers. Invalid runs are included so that an invalid run can never make
   *  cost-per-DVS look better, per protocol cost.invalidRunsImproveCostPerDvs = false. */
  basis: "ALL_RUNS_IN_SCOPE";
  runsInScope: number;
  runsWithKnownCost: number;
  runsWithUnknownCost: number;
  /** Fraction of in-scope runs whose cost is known. A complete ratio needs this to be 1. */
  coverage: number;
  knownCostUsd: number;
  /** Total known cost divided by DVS count. Only non-null when every in-scope run's cost is known;
   *  otherwise the figure would understate the true cost and is withheld. */
  costPerDvsUsd: number | null;
  /** Known cost divided by DVS count. A lower bound whenever coverage is below 1. */
  lowerBoundCostPerDvsUsd: number | null;
  status: "COMPLETE" | "PARTIAL" | "UNKNOWN" | "NO_DVS";
}

export interface EvaluationDurationAccounting {
  /** Mean elapsed time of DVS runs only. Named for what it measures: it excludes failures,
   *  timeouts and every non-DVS run, so it is not a general "time to safe". */
  meanElapsedOfDvsRunsMs: number | null;
  dvsRunsMeasured: number;
  /** Mean elapsed time across every valid run, for contrast with the figure above. */
  meanElapsedOfValidRunsMs: number | null;
  validRunsMeasured: number;
}

export interface EvaluationMetrics {
  runs: number;
  validRuns: number;
  invalidRuns: number;
  infrastructureFailures: number;
  runsWithCoherenceIssues: number;
  dvs: number;
  /** The protocol requires invalid runs to be reported separately
   *  (analysis.invalidRunsSeparate = true), so this is the headline rate and its denominator is
   *  valid runs. Null when there are no valid runs. */
  dvsRateAmongValidRuns: number | null;
  /** Reported alongside, never instead of, the rate above. */
  dvsRateAmongAllRuns: number | null;
  falseSafe: number;
  falseSafeRateAmongValidRuns: number | null;
  cost: EvaluationCostAccounting;
  duration: EvaluationDurationAccounting;
  paired: PairedTaskOutcome[];
}

export const isInfrastructureFailure = (run: EvaluationRun): boolean =>
  run.executionStatus === "INFRA_FAILURE" ||
  run.executionStatus === "TIMEOUT" ||
  run.executionStatus === "CANCELLED" ||
  run.executionStatus === "QUOTA_EXHAUSTED" ||
  Boolean(run.providerError || run.infrastructureError);

export const hasValidCandidate = (run: EvaluationRun): boolean =>
  run.candidateExists && run.candidateIntegrity === "VALID";

/**
 * Durable Verified Success.
 *
 * An infrastructure failure can never be a success, regardless of what the remaining fields claim:
 * a timed-out or quota-exhausted run did not durably verify anything, and an upstream payload that
 * says otherwise is contradicting itself.
 */
export const isDvs = (run: EvaluationRun): boolean =>
  !isInfrastructureFailure(run) &&
  run.runValidity === "VALID" &&
  hasValidCandidate(run) &&
  run.hiddenGrader === "PASS" &&
  run.regression === "PASS";

export const isFalseSafe = (run: EvaluationRun): boolean =>
  !isInfrastructureFailure(run) &&
  run.runValidity === "VALID" &&
  (run.claimedDone || run.claimedTrusted) &&
  !isDvs(run);

/**
 * Field combinations that contradict each other. Returning them rather than throwing lets a
 * pipeline keep accounting for a malformed run while recording that it was malformed; the run is
 * downgraded during normalization, never trusted.
 */
export const evaluationRunIncoherences = (run: EvaluationRun): string[] => {
  const issues: string[] = [];
  if (isInfrastructureFailure(run) && run.runValidity === "VALID") {
    issues.push(
      `executionStatus ${run.executionStatus} with an infrastructure error cannot be a VALID run`,
    );
  }
  if (!run.candidateExists && run.candidateIntegrity === "VALID") {
    issues.push("candidateIntegrity cannot be VALID when no candidate exists");
  }
  if (run.candidateExists && run.candidateIntegrity === "MISSING") {
    issues.push("candidateIntegrity cannot be MISSING when a candidate exists");
  }
  if (!run.candidateExists && (run.hiddenGrader === "PASS" || run.regression === "PASS")) {
    issues.push("grading cannot report PASS when no candidate exists");
  }
  if (isInfrastructureFailure(run) && (run.hiddenGrader === "PASS" || run.regression === "PASS")) {
    issues.push("grading cannot report PASS for a run that failed on infrastructure");
  }
  return issues;
};

const costStatus = (run: EvaluationRun): CostStatus => {
  if (run.costUsd !== undefined && Number.isFinite(run.costUsd) && run.costUsd >= 0) return "KNOWN";
  if (run.usage && Object.values(run.usage).some((value) => value !== undefined)) return "PARTIAL";
  return "UNKNOWN";
};

export const normalizeEvaluationRun = (run: EvaluationRun): NormalizedEvaluationRun => {
  if (!Number.isFinite(run.elapsedMs) || run.elapsedMs < 0) {
    throw new Error("Evaluation elapsedMs must be finite and non-negative");
  }
  if (run.costUsd !== undefined && (!Number.isFinite(run.costUsd) || run.costUsd < 0)) {
    throw new Error("Evaluation costUsd must be finite and non-negative");
  }
  const infrastructureFailure = isInfrastructureFailure(run);
  const coherenceIssues = evaluationRunIncoherences(run);
  // Downgrade only. An infrastructure failure makes the run invalid whatever it claimed.
  const effectiveRunValidity: RunValidity =
    infrastructureFailure || run.runValidity === "INVALID" ? "INVALID" : "VALID";
  return {
    ...structuredClone(run),
    costStatus: costStatus(run),
    dvs: isDvs(run),
    infrastructureFailure,
    falseSafe: isFalseSafe(run),
    effectiveRunValidity,
    coherenceIssues,
  };
};

export const pairedOutcome = (
  native: NormalizedEvaluationRun,
  maf: NormalizedEvaluationRun,
): PairedOutcome => {
  const nativeInvalid = native.effectiveRunValidity !== "VALID";
  const mafInvalid = maf.effectiveRunValidity !== "VALID";
  // Both-invalid is its own outcome. Collapsing it into INVALID_NATIVE hides that the MAF arm was
  // also unusable, which matters when reporting how much of a comparison actually ran.
  if (nativeInvalid && mafInvalid) return "INVALID_BOTH";
  if (nativeInvalid) return "INVALID_NATIVE";
  if (mafInvalid) return "INVALID_MAF";
  if (native.dvs && maf.dvs) return "BOTH_PASS";
  if (maf.dvs) return "MAF_ONLY_PASS";
  if (native.dvs) return "NATIVE_ONLY_PASS";
  return "BOTH_FAIL";
};

export const benchmarkStrategy = (condition: EvaluationCondition): BenchmarkStrategy =>
  condition === "NATIVE" ? "NATIVE" : "MAF_ADAPTIVE";
