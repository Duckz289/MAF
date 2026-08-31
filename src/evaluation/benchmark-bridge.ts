import type { BenchmarkSample } from "../benchmark/runner";
import { notVerified, type IndependentVerificationResult } from "./independent-verification";
import { summarizePairedEvaluation } from "./metrics";
import type {
  EvaluationCondition,
  EvaluationMetrics,
  EvaluationRun,
  ExecutionStatus,
  RunValidity,
} from "./types";

// Production wiring for the evaluation protocol.
//
// AUDIT #1 found the protocol semantics implemented but unreachable: nothing in any evaluation flow
// produced an EvaluationRun.
//
// AUDIT #2 found the wiring that fixed that was itself unsound. The three trusted fields were
// derived from the participant's own report:
//
//     hiddenGrader        <- sample.verificationResult === "VERIFIED"
//     regression          <- sample.verificationResult === "VERIFIED" && !verifierFailures
//     candidateIntegrity  <- sample.filesChanged.length > 0
//
// so a participant that returned VERIFIED with a fabricated file list minted a Durable Verified
// Success with no independent evidence in existence.
//
// The boundary this module now enforces:
//
//   participant execution          -> self-reported evidence only, recorded and never believed
//   controller-owned workspace     -> independent candidate-integrity evidence
//   controller-side hidden grader  -> hiddenGrader
//   controller-side regression     -> regression
//   infrastructure classification  -> run validity
//                                  -> DVS -> paired analysis
//
// A sample alone is no longer sufficient to build a run: an IndependentVerificationResult is
// required, and its absence resolves to NOT_CHECKED, which cannot be a DVS.

export const conditionForStrategy = (strategy: BenchmarkSample["strategy"]): EvaluationCondition =>
  strategy === "NATIVE" ? "NATIVE" : "MAF";

/** An execution that never finished cleanly is infrastructure, not evidence. */
const executionStatusFor = (sample: BenchmarkSample): ExecutionStatus =>
  sample.executionStatus ?? "COMPLETED";

/**
 * Builds a protocol run from a participant sample and the controller's independent verification.
 *
 * The sample contributes identity, timing, cost, infrastructure signals and self-reported
 * diagnostics. It contributes nothing to hiddenGrader, regression, candidateIntegrity or
 * candidateExists -- those come from `verification` alone.
 */
export const evaluationRunFromSample = (
  sample: BenchmarkSample,
  sourceRevision: string,
  verification: IndependentVerificationResult = notVerified(
    "no independent verification was supplied for this sample",
  ),
): EvaluationRun => {
  const executionStatus = executionStatusFor(sample);
  const infrastructureError = sample.infrastructureError;
  const infrastructure =
    executionStatus !== "COMPLETED" ||
    Boolean(infrastructureError) ||
    Boolean(sample.providerError);
  const runValidity: RunValidity = infrastructure ? "INVALID" : "VALID";

  // An infrastructure failure invalidates correctness evidence even if a verifier managed to run:
  // whatever it graded was not a completed run of this participant.
  const hiddenGrader = infrastructure ? "UNKNOWN" : verification.hiddenGrader;
  const regression = infrastructure ? "UNKNOWN" : verification.regression;
  const candidateIntegrity = infrastructure ? "UNKNOWN" : verification.candidateIntegrity;

  return {
    runId: sample.runId ?? `${sample.task.id}:${sample.strategy}`,
    condition: conditionForStrategy(sample.strategy),
    model: sample.model,
    provider: sample.provider,
    taskId: sample.task.id,
    executionStatus,
    candidateExists: !infrastructure && verification.candidateExists,
    candidateIntegrity,
    runValidity,
    evidenceSource: infrastructure ? "NOT_CHECKED" : verification.source,
    hiddenGrader,
    regression,
    selfReported: {
      verificationResult: sample.verificationResult,
      claimedChangedFiles: [...sample.filesChanged],
      verifierFailures: sample.verifierFailures,
      ...(sample.trustState ? { trustState: sample.trustState } : {}),
    },
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
  verifications: ReadonlyMap<BenchmarkSample, IndependentVerificationResult> = new Map(),
): EvaluationMetrics =>
  summarizePairedEvaluation(
    samples.map((sample) =>
      evaluationRunFromSample(sample, sourceRevision, verifications.get(sample)),
    ),
  );
