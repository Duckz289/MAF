import type { BenchmarkSample } from "../benchmark/runner";
import { summarizePairedEvaluation } from "./metrics";
import type {
  CandidateIntegrity,
  EvaluationCondition,
  EvaluationMetrics,
  EvaluationRun,
  EvidenceOutcome,
  ExecutionStatus,
  RunValidity,
} from "./types";

// Production wiring for the evaluation protocol.
//
// The independent audit of snapshot bb326527 found the protocol semantics implemented but reachable
// only from tests: nothing in the evaluation flow ever produced an EvaluationRun, so DVS, false-safe
// and cost accounting were never actually applied to a benchmark comparison.
//
// This module is the trace the protocol requires:
//
//   execution -> run validity -> candidate integrity -> grader result -> regression
//             -> infrastructure classification -> DVS -> paired analysis
//
// Each step is derived from the sample rather than asserted, and every unknown stays unknown.

export const conditionForStrategy = (strategy: BenchmarkSample["strategy"]): EvaluationCondition =>
  strategy === "NATIVE" ? "NATIVE" : "MAF";

/** An execution that never finished cleanly is infrastructure, not evidence. */
const executionStatusFor = (sample: BenchmarkSample): ExecutionStatus =>
  sample.executionStatus ?? "COMPLETED";

/**
 * Candidate integrity. A sample that changed no files produced no candidate to grade; a sample that
 * failed on infrastructure has a candidate of unknown integrity rather than a valid one.
 */
const candidateIntegrityFor = (
  sample: BenchmarkSample,
  infrastructure: boolean,
): CandidateIntegrity => {
  if (sample.filesChanged.length === 0) return "MISSING";
  if (infrastructure) return "UNKNOWN";
  return sample.verificationResult === "QUARANTINED" ? "INVALID" : "VALID";
};

/**
 * Hidden-grader outcome. VERIFIED is the executor's own claim about correctness evidence; it is
 * carried through as the grader result here, and the protocol still refuses to let that claim alone
 * become a DVS because candidate integrity, regression and run validity are separate conditions.
 */
const graderOutcomeFor = (sample: BenchmarkSample, infrastructure: boolean): EvidenceOutcome => {
  if (infrastructure || sample.filesChanged.length === 0) return "UNKNOWN";
  return sample.verificationResult === "VERIFIED" ? "PASS" : "FAIL";
};

/** Regression evidence. A verifier that failed outright is a regression signal, not a silence. */
const regressionOutcomeFor = (
  sample: BenchmarkSample,
  infrastructure: boolean,
): EvidenceOutcome => {
  if (infrastructure || sample.filesChanged.length === 0) return "UNKNOWN";
  if (sample.verifierFailures > 0) return "FAIL";
  return sample.verificationResult === "VERIFIED" ? "PASS" : "FAIL";
};

export const evaluationRunFromSample = (
  sample: BenchmarkSample,
  sourceRevision: string,
): EvaluationRun => {
  const executionStatus = executionStatusFor(sample);
  const infrastructureError = sample.infrastructureError;
  const infrastructure =
    executionStatus !== "COMPLETED" ||
    Boolean(infrastructureError) ||
    Boolean(sample.providerError);
  const candidateIntegrity = candidateIntegrityFor(sample, infrastructure);
  const runValidity: RunValidity = infrastructure ? "INVALID" : "VALID";
  return {
    runId: sample.runId ?? `${sample.task.id}:${sample.strategy}`,
    condition: conditionForStrategy(sample.strategy),
    model: sample.model,
    provider: sample.provider,
    taskId: sample.task.id,
    executionStatus,
    candidateExists: sample.filesChanged.length > 0,
    candidateIntegrity,
    runValidity,
    hiddenGrader: graderOutcomeFor(sample, infrastructure),
    regression: regressionOutcomeFor(sample, infrastructure),
    claimedDone: sample.verificationResult !== "FAILED",
    claimedTrusted:
      sample.trustState === "DURABLE_VERIFIED" || sample.trustState === "MERGE_ELIGIBLE",
    elapsedMs: sample.latencyMs,
    usage: {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cachedTokens: sample.cachedTokens,
    },
    ...(sample.reportedCost === null ? {} : { costUsd: sample.reportedCost }),
    ...(sample.providerError ? { providerError: sample.providerError } : {}),
    ...(infrastructureError ? { infrastructureError } : {}),
    sourceRevision,
  };
};

export const evaluateBenchmarkSamples = (
  samples: BenchmarkSample[],
  sourceRevision: string,
): EvaluationMetrics =>
  summarizePairedEvaluation(
    samples.map((sample) => evaluationRunFromSample(sample, sourceRevision)),
  );
