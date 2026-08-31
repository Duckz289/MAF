import { describe, expect, it } from "vitest";
import {
  assertIndependentDvs,
  pairEvaluationRuns,
  summarizeEvaluation,
  summarizePairedEvaluation,
} from "../src/evaluation/metrics";
import {
  evaluationRunIncoherences,
  normalizeEvaluationRun,
  type EvaluationRun,
} from "../src/evaluation/types";

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
  // Independently verified by default, so these fixtures describe runs whose evidence a
  // controller-side verifier actually produced.
  evidenceSource: "INDEPENDENT",
  hiddenGrader: "PASS",
  regression: "PASS",
  claimedDone: true,
  claimedTrusted: false,
  elapsedMs: 100,
  costUsd: 1,
  sourceRevision: "seed-sha",
  ...overrides,
});

describe("durable verified success", () => {
  it("requires independent grader, regression, candidate, and valid run", () => {
    expect(normalizeEvaluationRun(base()).dvs).toBe(true);
    expect(normalizeEvaluationRun(base({ hiddenGrader: "FAIL" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ hiddenGrader: "UNKNOWN" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ regression: "FAIL" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ regression: "UNKNOWN" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ candidateIntegrity: "INVALID" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ candidateIntegrity: "UNKNOWN" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ runValidity: "INVALID" })).dvs).toBe(false);
  });

  // The defect the independent audit reported: infrastructure failure was not part of the DVS
  // condition, so a timed-out run whose remaining fields claimed success was counted as one.
  it("refuses a timeout whose other fields claim success", () => {
    const timedOut = normalizeEvaluationRun(base({ executionStatus: "TIMEOUT" }));
    expect(timedOut.dvs).toBe(false);
    expect(timedOut.infrastructureFailure).toBe(true);
    expect(timedOut.effectiveRunValidity).toBe("INVALID");
    expect(timedOut.coherenceIssues.length).toBeGreaterThan(0);
  });

  it("refuses every other infrastructure failure mode", () => {
    for (const overrides of [
      { executionStatus: "INFRA_FAILURE" as const },
      { executionStatus: "CANCELLED" as const },
      { executionStatus: "QUOTA_EXHAUSTED" as const },
      { providerError: "429 from provider" },
      { infrastructureError: "sandbox unavailable" },
    ]) {
      const run = normalizeEvaluationRun(base(overrides));
      expect(run.dvs, JSON.stringify(overrides)).toBe(false);
      expect(run.infrastructureFailure, JSON.stringify(overrides)).toBe(true);
      expect(run.falseSafe, JSON.stringify(overrides)).toBe(false);
    }
  });

  // AUDIT #2's root cause: the production path derived correctness evidence from the participant's
  // own report, so asserting success was enough to mint a DVS. Evidence must now declare that a
  // controller-side verifier produced it.
  it("refuses evidence that did not come from an independent verifier", () => {
    const unverified = normalizeEvaluationRun(base({ evidenceSource: "NOT_CHECKED" }));
    expect(unverified.dvs).toBe(false);
    expect(unverified.coherenceIssues).toEqual([
      "correctness evidence cannot report PASS unless it came from an independent verifier",
      "candidateIntegrity cannot be VALID unless the controller observed the candidate",
    ]);
  });

  it("refuses evidence that was never checked", () => {
    expect(
      normalizeEvaluationRun(
        base({
          evidenceSource: "NOT_CHECKED",
          hiddenGrader: "NOT_CHECKED",
          regression: "NOT_CHECKED",
          candidateIntegrity: "UNKNOWN",
        }),
      ).dvs,
    ).toBe(false);
    expect(normalizeEvaluationRun(base({ hiddenGrader: "NOT_CHECKED" })).dvs).toBe(false);
    expect(normalizeEvaluationRun(base({ regression: "NOT_CHECKED" })).dvs).toBe(false);
  });

  // The participant's own claim is neither necessary nor sufficient.
  it("ignores the participant's claim in both directions", () => {
    expect(normalizeEvaluationRun(base({ claimedDone: false, claimedTrusted: false })).dvs).toBe(
      true,
    );
    expect(normalizeEvaluationRun(base({ claimedDone: true, hiddenGrader: "FAIL" })).dvs).toBe(
      false,
    );
  });

  it("refuses a missing candidate and a skipped verification", () => {
    const missing = normalizeEvaluationRun(
      base({
        candidateExists: false,
        candidateIntegrity: "MISSING",
        hiddenGrader: "UNKNOWN",
        regression: "UNKNOWN",
      }),
    );
    expect(missing.dvs).toBe(false);
    expect(missing.coherenceIssues).toEqual([]);

    const skipped = normalizeEvaluationRun(
      base({ hiddenGrader: "UNKNOWN", regression: "UNKNOWN" }),
    );
    expect(skipped.dvs).toBe(false);
    expect(skipped.falseSafe).toBe(true);
  });

  it("reports incoherent field combinations instead of trusting them", () => {
    expect(evaluationRunIncoherences(base({ candidateExists: false }))).toEqual([
      "candidateIntegrity cannot be VALID when no candidate exists",
      "grading cannot report PASS when no candidate exists",
    ]);
    expect(evaluationRunIncoherences(base({ candidateIntegrity: "MISSING" }))).toContain(
      "candidateIntegrity cannot be MISSING when a candidate exists",
    );
    expect(evaluationRunIncoherences(base())).toEqual([]);
  });
});

describe("false-safe classification", () => {
  it("detects a valid false-safe claim without blaming infrastructure failures", () => {
    expect(normalizeEvaluationRun(base({ hiddenGrader: "FAIL" })).falseSafe).toBe(true);
    expect(
      normalizeEvaluationRun(base({ hiddenGrader: "FAIL", executionStatus: "INFRA_FAILURE" }))
        .falseSafe,
    ).toBe(false);
  });

  it("does not classify an unclaimed failure as false-safe", () => {
    expect(
      normalizeEvaluationRun(
        base({ hiddenGrader: "FAIL", claimedDone: false, claimedTrusted: false }),
      ).falseSafe,
    ).toBe(false);
  });

  it("requires every claimed valid run to be classified", () => {
    expect(() => assertIndependentDvs(base())).not.toThrow();
    expect(() => assertIndependentDvs(base({ hiddenGrader: "FAIL" }))).not.toThrow();
    expect(() =>
      assertIndependentDvs(base({ claimedDone: false, claimedTrusted: false })),
    ).not.toThrow();
  });
});

describe("cost per DVS accounting", () => {
  // The audited implementation averaged cost across successful runs only, so two failed attempts
  // costing $100 each followed by a $1 success reported $1 per DVS instead of $201.
  it("divides total relevant cost by the number of successes", () => {
    const metrics = summarizeEvaluation([
      base({ runId: "a", taskId: "t1", hiddenGrader: "FAIL", costUsd: 100 }),
      base({ runId: "b", taskId: "t2", hiddenGrader: "FAIL", costUsd: 100 }),
      base({ runId: "c", taskId: "t3", costUsd: 1 }),
    ]);
    expect(metrics.dvs).toBe(1);
    expect(metrics.cost.status).toBe("COMPLETE");
    expect(metrics.cost.costPerDvsUsd).toBe(201);
    expect(metrics.cost.knownCostUsd).toBe(201);
    expect(metrics.cost.coverage).toBe(1);
  });

  it("keeps unknown cost unknown and never treats it as zero", () => {
    const missing = base();
    delete missing.costUsd;
    const metrics = summarizeEvaluation([missing]);
    expect(metrics.cost.status).toBe("UNKNOWN");
    expect(metrics.cost.costPerDvsUsd).toBeNull();
    expect(metrics.cost.lowerBoundCostPerDvsUsd).toBeNull();
    expect(metrics.cost.runsWithUnknownCost).toBe(1);
    expect(metrics.cost.coverage).toBe(0);
    expect(normalizeEvaluationRun(missing).costStatus).toBe("UNKNOWN");
  });

  it("withholds a complete ratio when cost coverage is partial", () => {
    const unknownCost = base({ runId: "b", taskId: "t2", hiddenGrader: "FAIL" });
    delete unknownCost.costUsd;
    const metrics = summarizeEvaluation([
      base({ runId: "a", taskId: "t1", costUsd: 5 }),
      unknownCost,
    ]);
    expect(metrics.cost.status).toBe("PARTIAL");
    expect(metrics.cost.costPerDvsUsd).toBeNull();
    expect(metrics.cost.lowerBoundCostPerDvsUsd).toBe(5);
    expect(metrics.cost.coverage).toBe(0.5);
    expect(metrics.cost.runsWithUnknownCost).toBe(1);
  });

  it("does not silently drop an unknown-cost success from the denominator", () => {
    const unknownCostSuccess = base({ runId: "b", taskId: "t2" });
    delete unknownCostSuccess.costUsd;
    const metrics = summarizeEvaluation([
      base({ runId: "a", taskId: "t1", costUsd: 10 }),
      unknownCostSuccess,
    ]);
    expect(metrics.dvs).toBe(2);
    expect(metrics.cost.status).toBe("PARTIAL");
    // 10 known dollars over 2 successes is a lower bound, not a complete figure.
    expect(metrics.cost.lowerBoundCostPerDvsUsd).toBe(5);
    expect(metrics.cost.costPerDvsUsd).toBeNull();
  });

  it("reports NO_DVS rather than dividing by zero", () => {
    const metrics = summarizeEvaluation([base({ hiddenGrader: "FAIL", costUsd: 50 })]);
    expect(metrics.dvs).toBe(0);
    expect(metrics.cost.status).toBe("NO_DVS");
    expect(metrics.cost.costPerDvsUsd).toBeNull();
    expect(metrics.cost.knownCostUsd).toBe(50);
  });

  // An invalid run must never make the ratio look better, per protocol
  // cost.invalidRunsImproveCostPerDvs = false.
  it("counts an invalid run's cost against the ratio", () => {
    const withoutInvalid = summarizeEvaluation([base({ runId: "a", taskId: "t1", costUsd: 4 })]);
    const withInvalid = summarizeEvaluation([
      base({ runId: "a", taskId: "t1", costUsd: 4 }),
      base({
        runId: "b",
        taskId: "t2",
        executionStatus: "TIMEOUT",
        candidateIntegrity: "UNKNOWN",
        hiddenGrader: "UNKNOWN",
        regression: "UNKNOWN",
        runValidity: "INVALID",
        costUsd: 20,
      }),
    ]);
    expect(withoutInvalid.cost.costPerDvsUsd).toBe(4);
    expect(withInvalid.cost.costPerDvsUsd).toBe(24);
    expect(withInvalid.cost.costPerDvsUsd!).toBeGreaterThan(withoutInvalid.cost.costPerDvsUsd!);
  });
});

describe("invalid run accounting", () => {
  it("separates invalid runs from the DVS denominator", () => {
    const metrics = summarizeEvaluation([
      base({ runId: "a", taskId: "t1" }),
      base({ runId: "b", taskId: "t2", hiddenGrader: "FAIL" }),
      base({
        runId: "c",
        taskId: "t3",
        executionStatus: "INFRA_FAILURE",
        runValidity: "INVALID",
        candidateExists: false,
        candidateIntegrity: "MISSING",
        hiddenGrader: "UNKNOWN",
        regression: "UNKNOWN",
        claimedDone: false,
      }),
    ]);
    expect(metrics.runs).toBe(3);
    expect(metrics.validRuns).toBe(2);
    expect(metrics.invalidRuns).toBe(1);
    expect(metrics.infrastructureFailures).toBe(1);
    expect(metrics.dvs).toBe(1);
    expect(metrics.dvsRateAmongValidRuns).toBe(0.5);
    expect(metrics.dvsRateAmongAllRuns).toBeCloseTo(1 / 3);
  });

  it("returns null rates rather than zero when there is nothing to divide", () => {
    const metrics = summarizeEvaluation([]);
    expect(metrics.dvsRateAmongValidRuns).toBeNull();
    expect(metrics.dvsRateAmongAllRuns).toBeNull();
    expect(metrics.falseSafeRateAmongValidRuns).toBeNull();
    expect(metrics.duration.meanElapsedOfDvsRunsMs).toBeNull();
  });

  it("counts runs whose fields contradicted each other", () => {
    const metrics = summarizeEvaluation([base({ executionStatus: "TIMEOUT" })]);
    expect(metrics.runsWithCoherenceIssues).toBe(1);
    expect(metrics.validRuns).toBe(0);
    expect(metrics.dvs).toBe(0);
  });
});

describe("duration accounting", () => {
  // The audited implementation labelled "mean duration of successful runs" as a general
  // time-to-safe. The field is now named for what it measures and reported next to its contrast.
  it("names the measured quantity and reports its denominator", () => {
    const metrics = summarizeEvaluation([
      base({ runId: "a", taskId: "t1", elapsedMs: 100 }),
      base({ runId: "b", taskId: "t2", elapsedMs: 300 }),
      base({ runId: "c", taskId: "t3", hiddenGrader: "FAIL", elapsedMs: 900 }),
    ]);
    expect(metrics.duration.meanElapsedOfDvsRunsMs).toBe(200);
    expect(metrics.duration.dvsRunsMeasured).toBe(2);
    expect(metrics.duration.meanElapsedOfValidRunsMs).toBeCloseTo(433.333, 2);
    expect(metrics.duration.validRunsMeasured).toBe(3);
  });
});

describe("paired outcomes", () => {
  it("separates invalid paired runs from both-fail", () => {
    const paired = pairEvaluationRuns([
      base({ runId: "native", condition: "NATIVE", runValidity: "INVALID" }),
      base({ runId: "maf", condition: "MAF", taskId: "task-1" }),
      base({ runId: "native-2", condition: "NATIVE", taskId: "task-2", hiddenGrader: "FAIL" }),
      base({ runId: "maf-2", condition: "MAF", taskId: "task-2", hiddenGrader: "FAIL" }),
    ]);
    expect(paired.map((entry) => entry.outcome)).toEqual(["INVALID_NATIVE", "BOTH_FAIL"]);
  });

  // The audited implementation short-circuited to INVALID_NATIVE, hiding that the MAF arm was also
  // unusable.
  it("represents a pair where both arms are invalid", () => {
    const paired = pairEvaluationRuns([
      base({ runId: "native", condition: "NATIVE", executionStatus: "TIMEOUT" }),
      base({ runId: "maf", condition: "MAF", executionStatus: "QUOTA_EXHAUSTED" }),
    ]);
    expect(paired.map((entry) => entry.outcome)).toEqual(["INVALID_BOTH"]);
  });

  it("distinguishes single-arm wins", () => {
    const paired = pairEvaluationRuns([
      base({ runId: "n1", condition: "NATIVE", taskId: "a", hiddenGrader: "FAIL" }),
      base({ runId: "m1", condition: "MAF", taskId: "a" }),
      base({ runId: "n2", condition: "NATIVE", taskId: "b" }),
      base({ runId: "m2", condition: "MAF", taskId: "b", regression: "FAIL" }),
      base({ runId: "n3", condition: "NATIVE", taskId: "c" }),
      base({ runId: "m3", condition: "MAF", taskId: "c" }),
    ]);
    expect(paired.map((entry) => entry.outcome)).toEqual([
      "MAF_ONLY_PASS",
      "NATIVE_ONLY_PASS",
      "BOTH_PASS",
    ]);
  });

  it("carries paired outcomes through the summary", () => {
    const metrics = summarizePairedEvaluation([
      base({ runId: "n", condition: "NATIVE" }),
      base({ runId: "m", condition: "MAF" }),
    ]);
    expect(metrics.paired).toHaveLength(1);
    expect(metrics.paired[0]?.outcome).toBe("BOTH_PASS");
  });
});
