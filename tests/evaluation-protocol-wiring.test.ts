import { describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
  type BenchmarkTask,
} from "../src/benchmark/runner";
import { evaluationRunFromSample } from "../src/evaluation/benchmark-bridge";
import {
  notVerified,
  type IndependentVerificationResult,
  type IndependentVerifier,
} from "../src/evaluation/independent-verification";

// Protocol wiring.
//
// AUDIT #1: the protocol semantics existed but nothing in any evaluation flow produced an
// EvaluationRun, so DVS and cost accounting were never applied to a comparison.
//
// AUDIT #2: the wiring that fixed that derived its trusted fields from the participant's own
// report. That defect is covered in depth by tests/production-trust-boundary.test.ts; this file
// covers the rest of the flow -- identity, cost, infrastructure classification and pairing -- now
// that correctness evidence arrives from a controller-side verifier instead.

const execution = (overrides: Partial<BenchmarkExecution> = {}): BenchmarkExecution => ({
  agent: "fixture-agent",
  model: "fixture-model",
  provider: "fixture",
  initialMode: "NATIVE",
  finalMode: "NATIVE",
  modeTransitions: [],
  signalSnapshots: [],
  inputTokens: 10,
  outputTokens: 5,
  cachedTokens: 0,
  reportedCost: 0.5,
  latencyMs: 120,
  retryCount: 0,
  verificationAttempts: 1,
  repairAttempts: 0,
  verifierFailures: 0,
  verificationResult: "VERIFIED",
  filesChanged: ["src/example.ts"],
  modulesTouched: ["src"],
  contextExpansion: 1,
  orchestrationOverheadMs: 3,
  ...overrides,
});

const task: BenchmarkTask = {
  id: "wiring-task",
  prompt: "Fix the fixture",
  expectedVerification: "npm test",
};

/** Stands in for the controller-side grader and regression run. */
const verifierReturning = (
  result: Partial<IndependentVerificationResult> = {},
): IndependentVerifier => ({
  async verify() {
    return {
      source: "INDEPENDENT",
      candidateIntegrity: "VALID",
      candidateExists: true,
      hiddenGrader: "PASS",
      regression: "PASS",
      graderStatus: "PASS",
      regressionStatus: "PASS",
      notes: [],
      ...result,
    };
  },
});

const compare = async (
  nativeExecution: BenchmarkExecution,
  mafExecution: BenchmarkExecution,
  verifier: IndependentVerifier = verifierReturning(),
) => {
  const executors: BenchmarkExecutor[] = [
    { strategy: "NATIVE", execute: async () => nativeExecution },
    { strategy: "MAF_ADAPTIVE", execute: async () => mafExecution },
  ];
  return await new BenchmarkRunner().compare(task, executors, { verifier });
};

describe("evaluation protocol wiring", () => {
  it("produces protocol accounting from a real comparison", async () => {
    const report = await compare(execution(), execution({ reportedCost: 0.25 }));
    expect(report.evaluation.runs).toBe(2);
    expect(report.evaluation.validRuns).toBe(2);
    expect(report.evaluation.dvs).toBe(2);
    expect(report.evaluation.dvsRateAmongValidRuns).toBe(1);
    expect(report.evaluation.cost.status).toBe("COMPLETE");
    expect(report.evaluation.cost.costPerDvsUsd).toBe(0.375);
    expect(report.evaluation.paired).toHaveLength(1);
    expect(report.evaluation.paired[0]?.outcome).toBe("BOTH_PASS");
  });

  it("refuses to call a timed-out execution a success", async () => {
    const report = await compare(
      execution({ executionStatus: "TIMEOUT" }),
      execution({ reportedCost: 0.25 }),
    );
    expect(report.evaluation.infrastructureFailures).toBe(1);
    expect(report.evaluation.invalidRuns).toBe(1);
    expect(report.evaluation.validRuns).toBe(1);
    expect(report.evaluation.dvs).toBe(1);
    expect(report.evaluation.dvsRateAmongValidRuns).toBe(1);
    expect(report.evaluation.paired[0]?.outcome).toBe("INVALID_NATIVE");
  });

  it("refuses a provider error even when the verifier passed the candidate", async () => {
    const report = await compare(
      execution({ providerError: "429 rate limited" }),
      execution({ infrastructureError: "sandbox unavailable" }),
    );
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.validRuns).toBe(0);
    expect(report.evaluation.dvsRateAmongValidRuns).toBeNull();
    expect(report.evaluation.paired[0]?.outcome).toBe("INVALID_BOTH");
  });

  it("carries an invalid candidate through as invalid integrity", async () => {
    const report = await compare(
      execution(),
      execution({ reportedCost: 0.25 }),
      verifierReturning({ candidateIntegrity: "INVALID" }),
    );
    expect(report.evaluation.paired[0]?.native.candidateIntegrity).toBe("INVALID");
    expect(report.evaluation.dvs).toBe(0);
  });

  it("carries a missing candidate through as missing, not as a pass", async () => {
    const report = await compare(
      execution({ filesChanged: [], modulesTouched: [] }),
      execution({ reportedCost: 0.25 }),
      verifierReturning({
        candidateIntegrity: "MISSING",
        candidateExists: false,
        hiddenGrader: "NOT_CHECKED",
        regression: "NOT_CHECKED",
        graderStatus: "NOT_RUN",
        regressionStatus: "NOT_RUN",
      }),
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateExists).toBe(false);
    expect(native?.candidateIntegrity).toBe("MISSING");
    expect(native?.hiddenGrader).toBe("NOT_CHECKED");
    expect(native?.dvs).toBe(false);
    expect(native?.coherenceIssues).toEqual([]);
  });

  it("keeps a failed independent regression out of DVS", async () => {
    const report = await compare(
      execution(),
      execution({ reportedCost: 0.25 }),
      verifierReturning({ regression: "FAIL", regressionStatus: "FAIL" }),
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.regression).toBe("FAIL");
    expect(native?.dvs).toBe(false);
    expect(native?.falseSafe).toBe(true);
  });

  it("keeps unknown executor cost unknown through the whole flow", async () => {
    const report = await compare(
      execution({ reportedCost: null }),
      execution({ reportedCost: 0.25 }),
    );
    expect(report.evaluation.cost.status).toBe("PARTIAL");
    expect(report.evaluation.cost.runsWithUnknownCost).toBe(1);
    expect(report.evaluation.cost.costPerDvsUsd).toBeNull();
    expect(report.evaluation.cost.lowerBoundCostPerDvsUsd).toBe(0.125);
  });

  it("charges a failed arm's cost against cost per success", async () => {
    let first = true;
    const alternating: IndependentVerifier = {
      async verify() {
        const failing = first;
        first = false;
        return {
          source: "INDEPENDENT",
          candidateIntegrity: "VALID",
          candidateExists: true,
          hiddenGrader: failing ? "FAIL" : "PASS",
          regression: failing ? "FAIL" : "PASS",
          graderStatus: failing ? "FAIL" : "PASS",
          regressionStatus: failing ? "FAIL" : "PASS",
          notes: [],
        };
      },
    };
    const report = await compare(
      execution({ reportedCost: 100 }),
      execution({ reportedCost: 1 }),
      alternating,
    );
    expect(report.evaluation.dvs).toBe(1);
    expect(report.evaluation.cost.costPerDvsUsd).toBe(101);
  });

  it("rejects a malformed infrastructure status fail-closed", async () => {
    const executors: BenchmarkExecutor[] = [
      {
        strategy: "NATIVE",
        execute: async () =>
          ({ ...execution(), executionStatus: "MAYBE" }) as unknown as BenchmarkExecution,
      },
      { strategy: "MAF_ADAPTIVE", execute: async () => execution() },
    ];
    await expect(
      new BenchmarkRunner().compare(task, executors, { verifier: verifierReturning() }),
    ).rejects.toThrow(/invalid execution status/i);
  });

  it("maps a sample into a protocol run without inventing evidence", () => {
    const run = evaluationRunFromSample(
      {
        ...execution(),
        task,
        strategy: "MAF_ADAPTIVE",
        costStatus: "REPORTED",
        verifiedSuccess: true,
      },
      "UNKNOWN",
      notVerified("no verifier in this unit"),
    );
    expect(run.condition).toBe("MAF");
    expect(run.taskId).toBe("wiring-task");
    expect(run.sourceRevision).toBe("UNKNOWN");
    expect(run.costUsd).toBe(0.5);
    expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
    // Absent verification never becomes evidence, whatever the sample claimed.
    expect(run.evidenceSource).toBe("NOT_CHECKED");
    expect(run.hiddenGrader).toBe("NOT_CHECKED");
    expect(run.regression).toBe("NOT_CHECKED");
    expect(run.candidateExists).toBe(false);
    expect(run.selfReported?.verificationResult).toBe("VERIFIED");
  });
});
