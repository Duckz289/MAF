import type { BenchmarkStrategy } from "../benchmark/runner";

export type EvaluationCondition = "NATIVE" | "MAF";
export type ExecutionStatus = "COMPLETED" | "INFRA_FAILURE" | "TIMEOUT" | "CANCELLED";
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
  | "INVALID_NATIVE";

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
}

export interface PairedTaskOutcome {
  taskId: string;
  outcome: PairedOutcome;
  native: NormalizedEvaluationRun;
  maf: NormalizedEvaluationRun;
}

export interface EvaluationMetrics {
  runs: number;
  validRuns: number;
  dvs: number;
  dvsRate: number;
  falseSafe: number;
  falseSafeRate: number;
  knownCostDvs: number;
  costPerDvsUsd: number | null;
  timeToSafeMs: number | null;
  paired: PairedTaskOutcome[];
}

export const isInfrastructureFailure = (run: EvaluationRun): boolean =>
  run.executionStatus === "INFRA_FAILURE" ||
  run.executionStatus === "TIMEOUT" ||
  run.executionStatus === "CANCELLED" ||
  Boolean(run.providerError || run.infrastructureError);

export const hasValidCandidate = (run: EvaluationRun): boolean =>
  run.candidateExists && run.candidateIntegrity === "VALID";

export const isDvs = (run: EvaluationRun): boolean =>
  run.runValidity === "VALID" &&
  hasValidCandidate(run) &&
  run.hiddenGrader === "PASS" &&
  run.regression === "PASS";

export const isFalseSafe = (run: EvaluationRun): boolean =>
  !isInfrastructureFailure(run) &&
  run.runValidity === "VALID" &&
  (run.claimedDone || run.claimedTrusted) &&
  (run.hiddenGrader === "FAIL" || run.regression === "FAIL" || !isDvs(run));

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
  return {
    ...structuredClone(run),
    costStatus: costStatus(run),
    dvs: isDvs(run),
    infrastructureFailure,
    falseSafe: isFalseSafe(run),
  };
};

export const pairedOutcome = (
  native: NormalizedEvaluationRun,
  maf: NormalizedEvaluationRun,
): PairedOutcome => {
  if (native.runValidity !== "VALID") return "INVALID_NATIVE";
  if (maf.runValidity !== "VALID") return "INVALID_MAF";
  if (native.dvs && maf.dvs) return "BOTH_PASS";
  if (maf.dvs) return "MAF_ONLY_PASS";
  if (native.dvs) return "NATIVE_ONLY_PASS";
  return "BOTH_FAIL";
};

export const benchmarkStrategy = (condition: EvaluationCondition): BenchmarkStrategy =>
  condition === "NATIVE" ? "NATIVE" : "MAF_ADAPTIVE";
