import { describe, expect, it } from "vitest";
import { pairEvaluationRuns, summarizePairedEvaluation } from "../src/evaluation/metrics";
import { normalizeEvaluationRun, type EvaluationRun } from "../src/evaluation/types";

const base = (overrides: Partial<EvaluationRun> = {}): EvaluationRun => ({
  runId: "run-1",
  condition: "NATIVE",
  model: "frontier-fixture",
  provider: "fixture",
  taskId: "task-1",
  executionStatus: "COMPLETED",
  candidateExists: true,
  candidateIntegrity: "VALID",
  runValidity: "VALID",
  hiddenGrader: "PASS",
  regression: "PASS",
  claimedDone: true,
  claimedTrusted: false,
  elapsedMs: 100,
  costUsd: 1,
  sourceRevision: "seed-sha",
  ...overrides,
});

describe("reconstructed evaluation semantics", () => {
  it("requires independent grader, regression, candidate, and valid run for DVS", () => {
    expect(normalizeEvaluationRun(base()).dvs).toBe(true);
    expect(normalizeEvaluationRun(base({ hiddenGrader: "FAIL" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ candidateIntegrity: "INVALID" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ runValidity: "INVALID" })).dvs).toBe(false);
  });

  it("classifies provider failure as invalid infrastructure, not false-safe", () => {
    const result = normalizeEvaluationRun(
      base({ executionStatus: "INFRA_FAILURE", candidateExists: false, claimedDone: false }),
    );
    expect(result.infrastructureFailure).toBe(true);
    expect(result.falseSafe).toBe(false);
    expect(result.dvs).toBe(false);
  });

  it("keeps missing cost unknown and never treats it as zero", () => {
    const missing = base();
    delete missing.costUsd;
    const result = normalizeEvaluationRun(missing);
    expect(result.costStatus).toBe("UNKNOWN");
    expect(result.dvs).toBe(true);
    expect(summarizePairedEvaluation([result]).costPerDvsUsd).toBeNull();
  });

  it("separates invalid paired runs from both-fail", () => {
    const paired = pairEvaluationRuns([
      base({ runId: "native", condition: "NATIVE", runValidity: "INVALID" }),
      base({ runId: "maf", condition: "MAF", taskId: "task-1" }),
      base({ runId: "native-2", condition: "NATIVE", taskId: "task-2", hiddenGrader: "FAIL" }),
      base({ runId: "maf-2", condition: "MAF", taskId: "task-2", hiddenGrader: "FAIL" }),
    ]);
    expect(paired.map((entry) => entry.outcome)).toEqual(["INVALID_NATIVE", "BOTH_FAIL"]);
  });

  it("detects a valid false-safe claim without blaming infrastructure failures", () => {
    expect(normalizeEvaluationRun(base({ hiddenGrader: "FAIL" })).falseSafe).toBe(true);
    expect(
      normalizeEvaluationRun(
        base({ hiddenGrader: "FAIL", executionStatus: "INFRA_FAILURE" }),
      ).falseSafe,
    ).toBe(false);
  });
});
