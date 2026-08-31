import { describe, expect, it } from "vitest";
import {
  BenchmarkRunner,
  type BenchmarkExecution,
  type BenchmarkExecutor,
  type BenchmarkTask,
} from "../src/benchmark/runner";
import { evaluationRunFromSample } from "../src/evaluation/benchmark-bridge";

// The independent audit of snapshot bb326527 found the protocol semantics reachable only from unit
// tests: no evaluation flow ever produced an EvaluationRun, so DVS, false-safe, invalid-run
// separation and cost accounting were never applied to a real comparison.
//
// These tests exercise the production path end to end:
//
//   BenchmarkRunner.compare -> BenchmarkSample -> evaluationRunFromSample -> run validity ->
//   candidate integrity -> grader -> regression -> infrastructure classification -> DVS ->
//   paired analysis -> BenchmarkReport.evaluation

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

const compare = async (nativeExecution: BenchmarkExecution, mafExecution: BenchmarkExecution) => {
  const executors: BenchmarkExecutor[] = [
    { strategy: "NATIVE", execute: async () => nativeExecution },
    { strategy: "MAF_ADAPTIVE", execute: async () => mafExecution },
  ];
  return await new BenchmarkRunner().compare(task, executors);
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

  it("refuses a provider error even when verification claims success", async () => {
    const report = await compare(
      execution({ providerError: "429 rate limited" }),
      execution({ infrastructureError: "sandbox unavailable" }),
    );
    expect(report.evaluation.dvs).toBe(0);
    expect(report.evaluation.validRuns).toBe(0);
    expect(report.evaluation.dvsRateAmongValidRuns).toBeNull();
    expect(report.evaluation.paired[0]?.outcome).toBe("INVALID_BOTH");
  });

  it("treats a quarantined candidate as invalid integrity, not a success", async () => {
    const report = await compare(
      execution({ verificationResult: "QUARANTINED" }),
      execution({ reportedCost: 0.25 }),
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateIntegrity).toBe("INVALID");
    expect(native?.dvs).toBe(false);
    expect(report.evaluation.paired[0]?.outcome).toBe("MAF_ONLY_PASS");
  });

  it("treats an execution that changed nothing as a missing candidate", async () => {
    const report = await compare(
      execution({ filesChanged: [], modulesTouched: [], verificationResult: "FAILED" }),
      execution({ reportedCost: 0.25 }),
    );
    const native = report.evaluation.paired[0]?.native;
    expect(native?.candidateExists).toBe(false);
    expect(native?.candidateIntegrity).toBe("MISSING");
    expect(native?.hiddenGrader).toBe("UNKNOWN");
    expect(native?.dvs).toBe(false);
    expect(native?.coherenceIssues).toEqual([]);
  });

  it("treats a verifier failure as a regression signal", async () => {
    const report = await compare(
      execution({ verifierFailures: 2, verificationAttempts: 3, verificationResult: "VERIFIED" }),
      execution({ reportedCost: 0.25 }),
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
    const report = await compare(
      execution({ verificationResult: "FAILED", reportedCost: 100 }),
      execution({ reportedCost: 1 }),
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
    await expect(new BenchmarkRunner().compare(task, executors)).rejects.toThrow(
      /invalid execution status/i,
    );
  });

  it("maps a sample into a protocol run without inventing a revision", () => {
    const run = evaluationRunFromSample(
      {
        ...execution(),
        task,
        strategy: "MAF_ADAPTIVE",
        costStatus: "REPORTED",
        verifiedSuccess: true,
      },
      "UNKNOWN",
    );
    expect(run.condition).toBe("MAF");
    expect(run.taskId).toBe("wiring-task");
    expect(run.sourceRevision).toBe("UNKNOWN");
    expect(run.costUsd).toBe(0.5);
    expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  });
});
