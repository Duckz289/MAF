import { describe, expect, it } from "vitest";
import { normalizeEvaluationRun, type EvaluationRun } from "../src/evaluation/types";
import { evaluationRunFromSample } from "../src/evaluation/benchmark-bridge";
import type { BenchmarkSample } from "../src/benchmark/runner";
import { notVerified } from "../src/evaluation/independent-verification";

// The repair loosened terminal-state classification: a structured success now survives a later
// nonzero exit, and a participant's own limit is a VALID run rather than an infrastructure failure.
// Both changes move runs INTO the valid-run denominator, so it matters that neither can turn a
// process anomaly into an unearned Durable Verified Success. These tests pin that.

const sample = (overrides: Partial<BenchmarkSample> = {}): BenchmarkSample =>
  ({
    agent: "claude-code",
    model: "claude-sonnet-5",
    provider: "anthropic",
    initialMode: "NATIVE",
    finalMode: "NATIVE",
    modeTransitions: [],
    signalSnapshots: [],
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    reportedCost: 0.1,
    latencyMs: 10,
    retryCount: 0,
    verificationAttempts: 1,
    repairAttempts: 0,
    verifierFailures: 0,
    verificationResult: "VERIFIED",
    filesChanged: ["src/format-name.mjs"],
    modulesTouched: [],
    contextExpansion: 0,
    orchestrationOverheadMs: 0,
    executionStatus: "COMPLETED",
    task: { id: "preflight-task", prompt: "p", expectedVerification: "v" },
    strategy: "NATIVE",
    costStatus: "REPORTED",
    verifiedSuccess: true,
    ...overrides,
  }) as BenchmarkSample;

describe("trust boundary survives the terminal-state repair", () => {
  it("a COMPLETED run with NO independent verification can never be a DVS", () => {
    // This is the shape the repair newly admits: the participant completed and claims success.
    const run = evaluationRunFromSample(sample(), "rev", notVerified("verifier not configured"));
    const normalized = normalizeEvaluationRun(run);

    expect(normalized.executionStatus).toBe("COMPLETED");
    expect(normalized.effectiveRunValidity).toBe("VALID");
    // Self-reported success plus a valid run still yields NO DVS without independent evidence.
    expect(normalized.evidenceSource).toBe("NOT_CHECKED");
    expect(normalized.dvs).toBe(false);
    // And it is correctly flagged as a false-safe: it claimed done without earning it.
    expect(normalized.falseSafe).toBe(true);
  });

  it("a participant's own limit is a VALID non-DVS run, not an infrastructure failure", () => {
    // PARTICIPANT_TASK_FAILURE maps to executionStatus COMPLETED so it stays in the denominator
    // (protocol 17.1). It must still never be a DVS.
    const run = evaluationRunFromSample(
      sample({ verificationResult: "FAILED", verifiedSuccess: false }),
      "rev",
      notVerified(),
    );
    const normalized = normalizeEvaluationRun(run);

    expect(normalized.effectiveRunValidity).toBe("VALID");
    expect(normalized.infrastructureFailure).toBe(false);
    expect(normalized.dvs).toBe(false);
  });

  it("an infrastructure failure can never be a DVS even if grading fields claim PASS", () => {
    const run: EvaluationRun = {
      runId: "r",
      condition: "NATIVE",
      model: "claude-sonnet-5",
      provider: "anthropic",
      taskId: "preflight-task",
      executionStatus: "INFRA_FAILURE",
      candidateExists: true,
      candidateIntegrity: "VALID",
      runValidity: "VALID",
      evidenceSource: "INDEPENDENT",
      hiddenGrader: "PASS",
      regression: "PASS",
      claimedDone: true,
      claimedTrusted: true,
      elapsedMs: 10,
      sourceRevision: "rev",
    };
    const normalized = normalizeEvaluationRun(run);

    expect(normalized.dvs).toBe(false);
    expect(normalized.effectiveRunValidity).toBe("INVALID");
    // The contradiction is recorded rather than silently accepted.
    expect(normalized.coherenceIssues.length).toBeGreaterThan(0);
  });

  it("keeps the executor's self-report out of the DVS decision entirely", () => {
    const run = evaluationRunFromSample(sample(), "rev", {
      source: "INDEPENDENT",
      candidateIntegrity: "VALID",
      candidateExists: true,
      hiddenGrader: "FAIL",
      regression: "PASS",
      graderStatus: "FAIL",
      regressionStatus: "PASS",
      notes: [],
    });
    const normalized = normalizeEvaluationRun(run);

    // Participant said VERIFIED; the independent grader said FAIL. The grader wins.
    expect(normalized.selfReported?.verificationResult).toBe("VERIFIED");
    expect(normalized.dvs).toBe(false);
    expect(normalized.falseSafe).toBe(true);
  });

  it("still requires BOTH hidden grader and regression to pass for a DVS", () => {
    const withRegressionNotChecked = normalizeEvaluationRun(
      evaluationRunFromSample(sample(), "rev", {
        source: "INDEPENDENT",
        candidateIntegrity: "VALID",
        candidateExists: true,
        hiddenGrader: "PASS",
        regression: "NOT_CHECKED",
        graderStatus: "PASS",
        regressionStatus: "NOT_RUN",
        notes: [],
      }),
    );
    expect(withRegressionNotChecked.dvs).toBe(false);

    const bothPass = normalizeEvaluationRun(
      evaluationRunFromSample(sample(), "rev", {
        source: "INDEPENDENT",
        candidateIntegrity: "VALID",
        candidateExists: true,
        hiddenGrader: "PASS",
        regression: "PASS",
        graderStatus: "PASS",
        regressionStatus: "PASS",
        notes: [],
      }),
    );
    expect(bothPass.dvs).toBe(true);
  });
});
